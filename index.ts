import TelegramBot from "node-telegram-bot-api";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import axios from "axios";
import fs from "fs";
import { S3 } from "aws-sdk";

const s3 = new S3();
const botToken = process.env.TELE_BOT_TOKEN as string;
const apiBedrock = process.env.API_BEDROCK as string;
const modelId = process.env.MODEL_ID as string;
const s3BucketKnowledgeBase = process.env.S3_BUCKET_KNOWLEDGE_BASE as string;

let bot: TelegramBot | null = null;
if (!bot) {
  bot = new TelegramBot(botToken);
  setupBotListeners(bot);
}

let globalResolve: (value: any) => void = () => {};

export const webhook = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const bodyParsed = JSON.parse(event.body!);
  console.log("bodyParsed", bodyParsed);

  await new Promise((resolve) => {
    globalResolve = resolve;
    bot!.processUpdate(bodyParsed);
    setTimeout(() => {
      resolve("global timeout");
    }, 10_000);
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Function executed successfully" }),
  };
};

function setupBotListeners(bot: TelegramBot) {
  bot.onText(/\/chat (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const question = match![1];

    try {
      const data = { question, modelId };
      const headers = { "Content-Type": "application/json" };

      const responseData = (
        await axios.post(`${apiBedrock}/docs`, data, { headers })
      ).data;

      await bot.sendMessage(chatId, `✅ Answer: ${responseData.response}`);
    } catch (error) {
      console.error(error);
      await bot.sendMessage(
        chatId,
        `❌ Error Response Answer for Question TODO: ${question} (${error})`
      );
    }
    globalResolve("ok");
  });

  bot.onText(/\/helps/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(
      chatId,
      "To Chat with me, type /chat <your question>.\nTo upload a document, send it to me with pin code."
    );
  });

  bot.on("document", async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.document?.file_id;
    const pinCode = msg.caption;
    if (!pinCode || Number(pinCode) !== Number(process.env.PIN_CODE)) {
      await bot.sendMessage(chatId, "❌ Invalid pin code. Please try again.");
      return;
    }

    if (!fileId) {
      await bot.sendMessage(chatId, "❌ No document found. Please try again.");
      return;
    }

    try {
      // Get the file URL from Telegram
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      // Notify the user of the file URL
      await bot.sendMessage(chatId, `fileUrl: ${fileUrl}`);

      // Download the file
      const fileName = msg.document?.file_name || "uploaded_document";
      const filePath = `/tmp/${fileName}`;
      const writer = fs.createWriteStream(filePath);
      const response = await axios({
        url: fileUrl,
        method: "GET",
        responseType: "stream",
      });
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", () => {
          resolve("file downloaded");
        });
        writer.on("error", reject);
      });

      // Upload to S3
      const s3Key = `knowledge-base/${fileName}_${Date.now()}`;
      const fileContent = fs.readFileSync(filePath);

      await s3
        .putObject({
          Bucket: s3BucketKnowledgeBase,
          Key: s3Key,
          Body: fileContent,
        })
        .promise();

      await bot.sendMessage(
        chatId,
        `✅ Document uploaded successfully to Knowledge Base as "${fileName}".`
      );

      // Clean up
      fs.unlinkSync(filePath);
    } catch (error) {
      console.error("Error handling document upload:", error);
      await bot.sendMessage(chatId, `❌ Failed to upload document: ${error}`);
    }

    globalResolve("ok");
  });
}
