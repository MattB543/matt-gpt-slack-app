require("dotenv").config();
const { App } = require("@slack/bolt");
const axios = require("axios");
const { v4: uuidv4 } = require('uuid');

// Initialize Slack Bolt app with Events API for production deployment
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false, // Using Events API for production
});

// Configuration
const MONITORED_CHANNEL = process.env.SLACK_CHANNEL_ID;
const MATT_GPT_API_URL = process.env.MATT_GPT_API_URL || "http://localhost:8000";
const MATT_GPT_BEARER_TOKEN = process.env.MATT_GPT_BEARER_TOKEN;

// Matt-GPT API integration with retry logic
async function callMattGPTWithRetry(message, context = {}, maxRetries = 3, logger) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Matt-GPT API attempt ${attempt}/${maxRetries}`);
      
      const response = await axios.post(
        `${MATT_GPT_API_URL}/chat`,
        {
          message: message,
          context: context,
          model: "anthropic/claude-3.5-sonnet"
        },
        {
          headers: {
            Authorization: `Bearer ${MATT_GPT_BEARER_TOKEN}`,
            "Content-Type": "application/json",
          },
          timeout: 30000, // 30 second timeout for Matt-GPT
        }
      );

      return response.data;
    } catch (error) {
      logger.warn(`Matt-GPT attempt ${attempt} failed:`, error.message);

      if (attempt === maxRetries) {
        throw new Error(`Matt-GPT API failed after ${maxRetries} attempts: ${error.message}`);
      }

      // Exponential backoff: 2^attempt seconds
      const delay = Math.pow(2, attempt) * 1000;
      logger.info(`Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Helper functions for conversation tracking using Slack message metadata
function extractConversationId(message) {
  // Look for conversation ID in various places where we might have stored it
  if (message.blocks) {
    for (const block of message.blocks) {
      if (block.block_id && block.block_id.startsWith('conv_')) {
        return block.block_id.replace('conv_', '');
      }
    }
  }
  
  // If no conversation ID found, return null (new conversation)
  return null;
}

function createMessageWithConversationId(text, conversationId, threadTs) {
  // Store conversation ID in a hidden block that doesn't display to users
  return {
    text: text,
    thread_ts: threadTs,
    blocks: [
      {
        type: "section",
        block_id: `conv_${conversationId}`, // Store conversation ID in block_id
        text: {
          type: "mrkdwn",
          text: text
        }
      }
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

// Global error handler with comprehensive Slack API error handling
app.error(async ({ error, logger, context, body }) => {
  const errorContext = {
    message: error.message,
    code: error.code,
    teamId: context?.teamId,
    userId: body?.user?.id,
    channelId: body?.event?.channel,
    timestamp: new Date().toISOString(),
  };

  logger.error("Global error occurred:", errorContext);

  // Handle specific Slack API errors
  if (error.code === "slack_webapi_platform_error") {
    const slackError = error.data?.error;
    
    logger.error("Slack API error details:", {
      error: slackError,
      needed: error.data?.needed,
      provided: error.data?.provided,
    });

    switch (slackError) {
      case "rate_limited":
        logger.warn("Rate limited by Slack API - implementing backoff");
        // In a production app, you might want to implement a backoff strategy here
        break;
      case "not_in_channel":
        logger.error("Bot is not in the channel - please invite the bot to the channel");
        break;
      case "missing_scope":
        logger.error(`Missing OAuth scope: ${error.data?.needed}. Current scopes: ${error.data?.provided}`);
        break;
      case "channel_not_found":
        logger.error("Channel not found - check if channel exists and bot has access");
        break;
      case "user_not_found":
        logger.error("User not found - user may have been deactivated");
        break;
      case "message_not_found":
        logger.error("Message not found - message may have been deleted");
        break;
      case "invalid_auth":
        logger.error("Invalid authentication - check bot token");
        break;
      case "account_inactive":
        logger.error("Slack account is inactive");
        break;
      default:
        logger.error(`Unhandled Slack API error: ${slackError}`);
    }
  } else if (error.code === "RequestError" || error.code === "ENOTFOUND") {
    logger.error("Network connectivity issue - check internet connection");
  } else if (error.name === "TimeoutError" || error.code === "ETIMEDOUT") {
    logger.error("Request timeout - external service may be slow");
  } else {
    logger.error("Unhandled error type:", error.stack);
  }

  // Additional safety: prevent error loops
  try {
    // You could implement error reporting to external services here
    // e.g., Sentry, DataDog, etc.
  } catch (reportingError) {
    logger.error("Failed to report error to external service:", reportingError.message);
  }
});

// Main message handler with channel filtering
app.message(async ({ message, say, client, logger }) => {
  // Filter by channel - only process messages from monitored channel
  if (MONITORED_CHANNEL && message.channel !== MONITORED_CHANNEL) {
    return;
  }

  // Skip bot messages and specific subtypes (except thread_broadcast)
  if (message.subtype && message.subtype !== "thread_broadcast") {
    return;
  }

  // Skip messages from bots (unless it's our own bot responding)
  if (message.bot_id) {
    return;
  }

  const { text, user, ts, thread_ts, channel, reply_count, reply_users_count } = message;
  
  // Detect message context for better thread handling
  const isInThread = Boolean(thread_ts);
  const isParentMessage = thread_ts === ts;
  const isThreadReply = thread_ts && thread_ts !== ts;
  
  logger.info(`Message from ${user} in ${channel}: ${text}`, {
    isInThread,
    isParentMessage,
    isThreadReply,
    replyCount: reply_count || 0
  });
  
  try {
    // Check if Matt-GPT API is configured
    if (!MATT_GPT_BEARER_TOKEN) {
      await say({
        text: "❌ Matt-GPT API is not configured. Please set MATT_GPT_BEARER_TOKEN environment variable.",
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Get or create conversation ID for this thread
    let conversationId = null;
    
    // If this is a thread reply, try to get conversation ID from parent or previous messages
    if (thread_ts && thread_ts !== ts) {
      try {
        // Get the thread history to find conversation ID
        const threadHistory = await client.conversations.replies({
          channel: channel,
          ts: thread_ts,
          limit: 50  // Get recent messages to find conversation ID
        });
        
        // Look through messages for existing conversation ID
        for (const msg of threadHistory.messages.reverse()) {
          if (msg.bot_id) { // Only check bot messages
            const existingConvId = extractConversationId(msg);
            if (existingConvId) {
              conversationId = existingConvId;
              logger.info(`Found existing conversation ID: ${conversationId}`);
              break;
            }
          }
        }
      } catch (error) {
        logger.warn("Could not retrieve thread history:", error.message);
      }
    }
    
    // Generate new conversation ID if none found
    if (!conversationId) {
      conversationId = uuidv4();
      logger.info(`Created new conversation ID: ${conversationId}`);
    }

    // Show thinking indicator
    const thinkingMsg = await say({
      text: "🤔 Thinking...",
      thread_ts: thread_ts || ts,
    });

    // Build context for Matt-GPT API
    const apiContext = {
      conversation_id: conversationId,
      thread_ts: thread_ts || ts,
      channel: channel,
      user_id: user
    };

    // Call Matt-GPT with retry logic
    logger.info("Calling Matt-GPT API...");
    const mattGPTResponse = await callMattGPTWithRetry(text, apiContext, 3, logger);
    
    // Log response details
    logger.info("Matt-GPT response received:", {
      query_id: mattGPTResponse.query_id,
      tokens_used: mattGPTResponse.tokens_used,
      latency_ms: mattGPTResponse.latency_ms,
      context_items_used: mattGPTResponse.context_items_used
    });

    // Update thinking message with response, including conversation ID in metadata
    const responsePayload = createMessageWithConversationId(
      mattGPTResponse.response,
      conversationId,
      thread_ts || ts
    );
    
    await client.chat.update({
      channel: channel,
      ts: thinkingMsg.ts,
      ...responsePayload
    });

  } catch (error) {
    logger.error("Error processing message:", error);
    
    // Determine user-friendly error message
    let userMessage;
    if (error.message.includes("timeout")) {
      userMessage = "⏰ Request timed out. Please try again.";
    } else if (error.message.includes("rate")) {
      userMessage = "🚦 Service is busy. Please wait a moment and try again.";
    } else if (error.message.includes("API")) {
      userMessage = "🤖 Matt-GPT is temporarily unavailable. Please try again later.";
    } else {
      userMessage = "❌ Something went wrong. Please try again.";
    }
    
    // Try to send error message
    try {
      await say({
        text: userMessage,
        thread_ts: thread_ts || ts,
      });
    } catch (fallbackError) {
      logger.error("Error sending fallback message:", fallbackError);
    }
  }
});

// Startup validation and safety checks
function validateConfiguration() {
  const requiredEnvVars = {
    'SLACK_BOT_TOKEN': process.env.SLACK_BOT_TOKEN,
    'SLACK_SIGNING_SECRET': process.env.SLACK_SIGNING_SECRET,
  };

  const missingVars = Object.entries(requiredEnvVars)
    .filter(([key, value]) => !value)
    .map(([key]) => key);

  if (missingVars.length > 0) {
    console.error("❌ Missing required environment variables:");
    missingVars.forEach(varName => console.error(`  - ${varName}`));
    console.error("\n📝 Please check your .env file and ensure all required variables are set.");
    console.error("📖 See .env.sample for reference.");
    return false;
  }

  // Validate token formats
  if (!process.env.SLACK_BOT_TOKEN.startsWith('xoxb-')) {
    console.error("❌ SLACK_BOT_TOKEN should start with 'xoxb-'");
    return false;
  }

  return true;
}

// Start the app with comprehensive error handling
(async () => {
  try {
    // Validate configuration before starting
    if (!validateConfiguration()) {
      process.exit(1);
    }

    console.log("🔧 Configuration validated successfully");
    console.log("🚀 Starting Slack bot...");
    
    await app.start(process.env.PORT || 3000);
    
    console.log("⚡️ Slack bot is running!");
    console.log(`📢 Monitoring channel: ${MONITORED_CHANNEL || '⚠️ Not configured - will respond to all channels'}`);
    console.log(`🤖 Matt-GPT integration: ${MATT_GPT_BEARER_TOKEN ? '✅ Enabled' : '⚠️ Disabled (MATT_GPT_BEARER_TOKEN not set)'}`);
    console.log(`🔗 Matt-GPT API URL: ${MATT_GPT_API_URL}`);
    console.log(`🌐 Events API: Enabled (production mode)`);
    console.log(`🔗 Webhook endpoint: https://your-domain.com/slack/events`);
    console.log("\n🎉 Bot is ready to receive messages!");
    
  } catch (error) {
    console.error("💥 Failed to start app:", error.message);
    
    if (error.code === 'slack_webapi_platform_error') {
      console.error("🔐 This is likely an authentication issue. Please check:");
      console.error("  - Your bot token is valid and starts with 'xoxb-'");
      console.error("  - Your signing secret is correct");
      console.error("  - Your app has the necessary OAuth scopes");
      console.error("  - Events API is properly configured in your Slack app");
    } else if (error.code === 'EADDRINUSE') {
      console.error(`🚪 Port ${process.env.PORT || 3000} is already in use. Try a different port.`);
    }
    
    process.exit(1);
  }
})();