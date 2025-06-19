import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import { config } from "dotenv";
import fetch from "node-fetch";
import FormData from "form-data"; 
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegPath); 

config(); 

const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" });

app.use("/uploads", express.static("uploads"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const convertWebmToMp3 = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat("mp3")
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
};

app.post("/ask", upload.single("audio"), async (req, res) => {
  const webmPath = req.file.path;
  const mp3Path = `uploads/converted-${Date.now()}.mp3`;

  try {
    await convertWebmToMp3(webmPath, mp3Path);

    const form = new FormData();
    form.append("file", fs.createReadStream(mp3Path));
    form.append("model", "whisper-1");

    const sttRes = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form,
      }
    );

    const sttJson = await sttRes.json();
    const text = sttJson.text?.trim();

    if (!text) {
      return res
        .status(400)
        .json({ error: "No speech recognized. Try again with clearer audio." });
    }

    const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: text }],
      }),
    });

    const chatJson = await chatRes.json();

    if (!chatJson.choices || !chatJson.choices[0]) {
      console.error("GPT response error:", chatJson);
      return res.status(500).json({
        error: "Failed to get a response from OpenAI",
        detail: chatJson,
      });
    }

    const reply = chatJson.choices[0].message.content;

    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: reply,
        voice: "alloy",
        response_format: "mp3",
      }),
    });

    const audioFileName = `tts-${Date.now()}.mp3`;
    const audioFilePath = `uploads/${audioFileName}`;
    const fileStream = fs.createWriteStream(audioFilePath);

    await new Promise((resolve, reject) => {
      ttsRes.body.pipe(fileStream);
      ttsRes.body.on("error", reject);
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });

    res.json({
      transcription: text,
      reply,
      audioUrl: `http://localhost:3000/uploads/${audioFileName}`,
    });

    fs.unlinkSync(webmPath);
    fs.unlinkSync(mp3Path);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong.", detail: err.message });
  }
});

app.use("/uploads", express.static("uploads"));

app.listen(3000, () => {
  console.log("Server listening at http://localhost:3000");
});
