import TelegramBot from "node-telegram-bot-api";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import axios from "axios";
import fs from "fs";
import { S3 } from "aws-sdk";
import { WebCrawlerUrlData } from "./type";

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
      `🤖 *AI Bot Commands*       
      🔹 **Chat with AI**  
      \`/chat <question>\` - Ask the bot any question.  

      🔹 **Admin Commands** *(Users with Pin Code can use these)*  
      \`/get-seed-urls pinCode:<pincode>\` - Retrieve the current list of seed URLs used for the Knowledge Base.  

      🔹 **Update Knowledge Base for AI Bot**  
      Our AI uses *two data sources*: *Web Crawling* & *Text Files*.  

      🌐 **Using Web Crawling**  
      \`/update-seed-urls url:url1,url2 pinCode:<pincode>\`  
      - Adds new website URLs to the Knowledge Base.  
      - The bot will sync data from the websites *once per day*.  

      📄 **Using Text Files**  
      - Upload a txt file containing information for the AI.  
      - In the caption, include:  \`pinCode:<pincode>\`  
      - The file content will be added to the AI’s Knowledge Base.  

      ⚡ *Ensure the URLs are static and the text file contains structured data for better AI training!*  
      `,
      { parse_mode: "Markdown" }
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
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      await bot.sendMessage(chatId, `fileUrl: ${fileUrl}`);

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

      fs.unlinkSync(filePath);
    } catch (error) {
      console.error("Error handling document upload:", error);
      await bot.sendMessage(chatId, `❌ Failed to upload document: ${error}`);
    }

    globalResolve("ok");
  });

  bot.onText(/\/get-seed-urls (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (match === null) {
      return await bot.sendMessage(
        chatId,
        "Invalid format. Please use: /update-seed-urls pinCode: yourPin"
      );
    }
    const text = match[1].trim();
    try {
      const pinMatch = text.match(/pinCode:\s*(\S+)/);

      if (!pinMatch) {
        return bot.sendMessage(
          chatId,
          "Invalid format. Please use: \n/get-seed-urls pinCode: yourPin"
        );
      }

      const pinCode = pinMatch[1].trim();

      if (Number(pinCode) !== Number(process.env.PIN_CODE)) {
        return bot.sendMessage(
          chatId,
          "❌ Invalid pin code. Please try again."
        );
      }

      const responseData = (await axios.get(`${apiBedrock}/urls`))
        .data as WebCrawlerUrlData;

      const urls = (responseData.seedUrlList || []).map((data) => data.url);

      bot.sendMessage(
        chatId,
        "✅ Seed URLs:\n" + urls.map((url) => `- ${url}`).join("\n")
      );
    } catch (error) {
      console.error("Error processing /get-seed-urls:", error);
      bot.sendMessage(
        chatId,
        "❌ Error updating Knowledge Base. Please try again."
      );
    }
  });

  bot.onText(/\/update-seed-urls (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (match === null) {
      return bot.sendMessage(
        chatId,
        "Invalid format. Please use: /update-seed-urls url:url1,url2 pinCode: yourPin"
      );
    }
    const text = match[1].trim();

    try {
      const urlMatch = text.match(/url:([\S]+)/);
      const pinMatch = text.match(/pinCode:\s*(\S+)/);

      if (!urlMatch || !pinMatch) {
        return bot.sendMessage(
          chatId,
          "Invalid format. Please use: \n/update-seed-urls url:url1,url2 pinCode: yourPin"
        );
      }

      const urls = urlMatch[1].split(",").map((url) => url.trim());
      const pinCode = pinMatch[1].trim();

      const urlRegex = /^(https?:\/\/[^\s]+)$/;
      if (!urls.every((url) => urlRegex.test(url))) {
        return bot.sendMessage(
          chatId,
          "One or more URLs are invalid. Please provide valid URLs."
        );
      }

      if (Number(pinCode) !== Number(process.env.PIN_CODE)) {
        return bot.sendMessage(
          chatId,
          "❌ Invalid pin code. Please try again."
        );
      }

      await bot.sendMessage(
        chatId,
        `Processing update for:\nURLs: ${urls.join("\n")}`
      );

      const data = {
        urlList: urls,
        exclusionFilters: ["https://www\.examplesite\.com/contact-us\.html"],
        inclusionFilters: ["https://www\.examplesite\.com/.*\.html"],
      };
      const headers = { "Content-Type": "application/json" };

      await axios.post(`${apiBedrock}/web-urls`, data, { headers });

      bot.sendMessage(
        chatId,
        "✅ URLs successfully added to the Knowledge Base!"
      );
    } catch (error) {
      console.error("Error processing /update-seed-urls:", error);
      bot.sendMessage(
        chatId,
        "❌ Error updating Knowledge Base. Please try again."
      );
    }
  });
}
