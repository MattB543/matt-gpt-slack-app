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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Matt-GPT API integration with retry logic
async function callMattGPTWithRetry(message, context = {}, maxRetries = 3, logger) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`🔄 Matt-GPT API attempt ${attempt}/${maxRetries}`);
      
      const requestPayload = {
        message: message,
        openrouter_api_key: OPENROUTER_API_KEY
      };
      
      // Add conversation_id for thread replies (continuing conversations)
      if (context.conversation_id) {
        requestPayload.conversation_id = context.conversation_id;
      }

      const requestConfig = {
        headers: {
          Authorization: `Bearer ${MATT_GPT_BEARER_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 30000, // 30 second timeout for Matt-GPT
      };

      // Log the exact request being made
      logger.info(`📤 Request to ${MATT_GPT_API_URL}/chat:`, {
        payload: JSON.stringify({
          ...requestPayload,
          openrouter_api_key: OPENROUTER_API_KEY ? `${OPENROUTER_API_KEY.substring(0, 12)}...` : 'NOT_SET'
        }, null, 2),
        headers: {
          'Authorization': `Bearer ${MATT_GPT_BEARER_TOKEN?.substring(0, 8)}...`,
          'Content-Type': requestConfig.headers['Content-Type']
        }
      });
      
      const response = await axios.post(
        `${MATT_GPT_API_URL}/chat`,
        requestPayload,
        requestConfig
      );

      logger.info(`📥 Matt-GPT API success:`, {
        status: response.status,
        data: response.data
      });

      return response.data;
    } catch (error) {
      // Log detailed error information
      if (error.response) {
        logger.error(`❌ Matt-GPT API Error (attempt ${attempt}):`, {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers
        });
      } else if (error.request) {
        logger.error(`❌ Matt-GPT Network Error (attempt ${attempt}):`, {
          message: error.message,
          code: error.code,
          url: error.config?.url
        });
      } else {
        logger.error(`❌ Matt-GPT Unknown Error (attempt ${attempt}):`, {
          message: error.message,
          stack: error.stack
        });
      }

      if (attempt === maxRetries) {
        throw new Error(`Matt-GPT API failed after ${maxRetries} attempts: ${error.message}`);
      }

      // Exponential backoff: 2^attempt seconds
      const delay = Math.pow(2, attempt) * 1000;
      logger.info(`⏳ Retrying in ${delay}ms...`);
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

// Helper function to detect if channel is a DM
function isDMChannel(channelId) {
  return channelId.startsWith('D'); // Direct messages (1:1) start with 'D'
}

// Helper function to detect if channel is likely a group DM or private channel
function isProbablyGroupDMOrPrivateChannel(channelId) {
  return channelId.startsWith('G'); // Both group DMs and private channels start with 'G'
}

// Helper function to clean @mentions from message text
function cleanMessageText(text) {
  if (!text) return text;
  
  // Remove @mentions from the beginning of the message
  // Pattern matches: <@U12345678> or <@U12345678|username>
  const cleanedText = text.replace(/^<@[UW][A-Z0-9]+(?:\|[^>]+)?>\s*/g, '').trim();
  
  return cleanedText;
}

// Main message handler with channel filtering
app.message(async ({ message, say, client, logger }) => {
  const { channel } = message;
  
  // Skip bot messages - comprehensive bot detection
  // Method 1: Check for bot_id (most reliable for detecting bot messages)
  if (message.bot_id) {
    logger.debug(`Ignoring message from bot: ${message.bot_id}`);
    return;
  }
  
  // Method 2: Check for specific subtypes that indicate automated messages
  if (message.subtype) {
    // Allow thread_broadcast (when user broadcasts thread reply to channel)
    // Block all other subtypes which are typically automated/bot messages
    if (message.subtype !== "thread_broadcast") {
      logger.debug(`Ignoring message with subtype: ${message.subtype}`);
      return;
    }
  }
  
  // Method 3: Additional check for bot_profile (backup detection)
  if (message.bot_profile) {
    logger.debug(`Ignoring message with bot_profile: ${message.bot_profile.name}`);
    return;
  }

  // Method 4: Check for Slackbot specifically (user ID is typically USLACKBOT)
  if (message.user === 'USLACKBOT') {
    logger.debug(`Ignoring message from Slackbot`);
    return;
  }

  // Handle DM messages - redirect to monitored channel
  if (isDMChannel(channel)) {
    if (MONITORED_CHANNEL) {
      await say({
        text: `👋 Hi there! I only respond to messages in <#${MONITORED_CHANNEL}>. Please write your message there and I'll respond in the thread!`,
      });
    } else {
      await say({
        text: `👋 Hi there! I only respond to messages in channels, not DMs. Please write your message in a channel where I'm present and I'll respond in the thread!`,
      });
    }
    return;
  }

  // Handle Group DMs - also redirect (but allow private channels to pass through)
  if (isProbablyGroupDMOrPrivateChannel(channel) && MONITORED_CHANNEL && channel !== MONITORED_CHANNEL) {
    // For now, treat all 'G' channels the same - redirect if not the monitored channel
    // Private channels will be allowed if they're the monitored channel
    return; // Silently ignore group DMs and non-monitored private channels
  }

  // Filter by channel - only process messages from monitored channel
  if (MONITORED_CHANNEL && channel !== MONITORED_CHANNEL) {
    return;
  }

  const { text, user, ts, thread_ts, reply_count, reply_users_count } = message;
  
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
  
  // Check if this message should trigger a response
  // Rule 1: If it contains @mention, let app_mention handler process it (avoid duplicates)
  // Rule 2: If it's a thread reply WITHOUT @mention in an existing conversation, respond
  let shouldRespond = false;
  
  // Check if message contains @mention to this bot
  const containsMention = text && text.includes(`<@${process.env.SLACK_BOT_USER_ID || 'U09BR46BEV8'}>`);
  
  if (containsMention) {
    // This message @mentions the bot - let app_mention handler process it
    shouldRespond = false;
    logger.debug(`Message contains @mention - letting app_mention handler process it`);
  } else if (isThreadReply) {
    // This is a thread reply WITHOUT @mention - check if we have a conversation going
    try {
      const threadHistory = await client.conversations.replies({
        channel: channel,
        ts: thread_ts,
        limit: 50
      });
      
      // Look for any bot messages in this thread to determine if we're in a conversation
      const hasBotMessages = threadHistory.messages.some(msg => msg.bot_id);
      if (hasBotMessages) {
        shouldRespond = true;
        logger.info(`Responding to thread reply - existing conversation found`);
      }
    } catch (error) {
      logger.warn("Could not check thread history for bot messages:", error.message);
    }
  } else {
    // This is a new message without @mention - ignore
    shouldRespond = false;
    logger.debug(`New message without mention - ignored`);
  }
  
  // If we shouldn't respond, ignore the message
  if (!shouldRespond) {
    logger.debug(`Ignoring message - no mention and not in active thread`);
    return;
  }
  
  // Use the extracted processing function
  await processMessageRequest(message, say, client, logger);
});

// Handle app mentions specifically (when bot is @mentioned)
app.event('app_mention', async ({ event, say, client, logger }) => {
  const { channel, user, text, ts, thread_ts } = event;
  
  logger.info(`🔔 App mentioned by ${user} in ${channel}: ${text}`);
  
  // Only respond if in monitored channel (or no channel restriction)
  if (MONITORED_CHANNEL && channel !== MONITORED_CHANNEL) {
    logger.info(`❌ Ignoring mention - not in monitored channel. Expected: ${MONITORED_CHANNEL}, Got: ${channel}`);
    return;
  }
  
  logger.info(`✅ Processing mention in correct channel`);
  
  // Process this as a regular message by calling the same logic
  // Create a mock message object to reuse our existing logic
  const mockMessage = {
    channel,
    user,
    text,
    ts,
    thread_ts,
    type: 'message'
  };
  
  logger.info(`📨 Created mock message object for processing:`, mockMessage);
  
  // Call the same processing logic
  await processMessageRequest(mockMessage, say, client, logger);
});

// Extract the main message processing logic into a separate function
async function processMessageRequest(message, say, client, logger) {
  const { text, user, ts, thread_ts, channel } = message;
  
  // Clean the message text (remove @mentions)
  const cleanedText = cleanMessageText(text);
  
  // Check for "side note" variations - skip processing if message starts with any of these
  if (cleanedText) {
    const lowerText = cleanedText.toLowerCase();
    if (lowerText.startsWith('side note') || lowerText.startsWith('sidenote') || lowerText.startsWith('side-note')) {
      logger.info(`💭 Skipping message - starts with side note variation:`, {
        user,
        text: cleanedText?.substring(0, 100) + (cleanedText?.length > 100 ? '...' : '')
      });
      return;
    }
  }
  
  logger.info(`🚀 Starting message processing:`, {
    user,
    channel,
    originalText: text?.substring(0, 100) + (text?.length > 100 ? '...' : ''),
    cleanedText: cleanedText?.substring(0, 100) + (cleanedText?.length > 100 ? '...' : ''),
    ts,
    thread_ts,
    messageType: thread_ts && thread_ts !== ts ? 'thread_reply' : 'new_message'
  });
  
  try {
    // Check if Matt-GPT API is configured
    logger.info(`🔧 Checking Matt-GPT API configuration...`);
    if (!MATT_GPT_BEARER_TOKEN) {
      logger.error(`❌ MATT_GPT_BEARER_TOKEN not configured`);
      await say({
        text: "❌ Matt-GPT API is not configured. Please set MATT_GPT_BEARER_TOKEN environment variable.",
        thread_ts: thread_ts || ts,
      });
      return;
    }
    
    if (!OPENROUTER_API_KEY) {
      logger.error(`❌ OPENROUTER_API_KEY not configured`);
      await say({
        text: "❌ OpenRouter API key is not configured. Please set OPENROUTER_API_KEY environment variable.",
        thread_ts: thread_ts || ts,
      });
      return;
    }
    
    logger.info(`✅ Matt-GPT API configuration OK`);
    logger.info(`✅ OpenRouter API key configured`);

    // Get conversation ID for this thread (only for thread replies)
    logger.info(`🔍 Getting conversation ID for thread...`);
    let conversationId = null;
    
    // If this is a thread reply, try to get conversation ID from previous bot messages
    if (thread_ts && thread_ts !== ts) {
      logger.info(`📜 This is a thread reply - searching for existing conversation ID`);
      try {
        // Get the thread history to find conversation ID
        logger.info(`🔍 Fetching thread history for thread_ts: ${thread_ts}`);
        const threadHistory = await client.conversations.replies({
          channel: channel,
          ts: thread_ts,
          limit: 50  // Get recent messages to find conversation ID
        });
        
        logger.info(`📝 Thread history retrieved: ${threadHistory.messages.length} messages`);
        
        // Look through messages for existing conversation ID
        for (const msg of threadHistory.messages.reverse()) {
          if (msg.bot_id) { // Only check bot messages
            logger.info(`🤖 Checking bot message for conversation ID...`);
            const existingConvId = extractConversationId(msg);
            if (existingConvId) {
              conversationId = existingConvId;
              logger.info(`✅ Found existing conversation ID: ${conversationId}`);
              break;
            }
          }
        }
        
        if (!conversationId) {
          logger.info(`🔍 No existing conversation ID found in thread history`);
        }
      } catch (error) {
        logger.error("❌ Could not retrieve thread history:", error.message);
      }
    } else {
      logger.info(`💬 This is a new message - will get conversation ID from API response`);
    }

    // Show thinking indicator
    logger.info(`💭 Posting thinking indicator...`);
    const thinkingMsg = await say({
      text: "🤔 Thinking...",
      thread_ts: thread_ts || ts,
    });
    logger.info(`✅ Thinking message posted with ts: ${thinkingMsg.ts}`);

    // Build context for Matt-GPT API
    logger.info(`📋 Building API context...`);
    const apiContext = {
      thread_ts: thread_ts || ts,
      channel: channel,
      user_id: user
    };
    
    // Only include conversation_id for thread replies (continuing conversations)
    if (conversationId) {
      apiContext.conversation_id = conversationId;
      logger.info(`📋 API context built with conversation ID:`, apiContext);
    } else {
      logger.info(`📋 API context built for new conversation:`, apiContext);
    }

    // Call Matt-GPT with retry logic
    logger.info("🔄 Calling Matt-GPT API...");
    const mattGPTResponse = await callMattGPTWithRetry(cleanedText, apiContext, 3, logger);
    
    // Log response details
    logger.info("📥 Matt-GPT response received:", {
      query_id: mattGPTResponse.query_id,
      tokens_used: mattGPTResponse.tokens_used,
      latency_ms: mattGPTResponse.latency_ms,
      context_items_used: mattGPTResponse.context_items_used,
      responseLength: mattGPTResponse.response?.length,
      conversation_id: mattGPTResponse.conversation_id
    });

    // Get conversation ID from API response (for new conversations)
    const responseConversationId = mattGPTResponse.conversation_id || conversationId;
    logger.info(`💾 Using conversation ID: ${responseConversationId} (from ${mattGPTResponse.conversation_id ? 'API response' : 'thread history'})`);

    // Update thinking message with response, including conversation ID in metadata
    logger.info(`🔄 Updating thinking message with response...`);
    const responsePayload = createMessageWithConversationId(
      mattGPTResponse.response,
      responseConversationId,
      thread_ts || ts
    );
    logger.info(`📝 Response payload created:`, {
      text: responsePayload.text?.substring(0, 100) + '...',
      thread_ts: responsePayload.thread_ts,
      blocks: responsePayload.blocks?.length ? `${responsePayload.blocks.length} blocks` : 'no blocks'
    });
    
    const updateResult = await client.chat.update({
      channel: channel,
      ts: thinkingMsg.ts,
      ...responsePayload
    });
    
    logger.info(`✅ Message updated successfully:`, {
      ok: updateResult.ok,
      ts: updateResult.ts
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
}

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
    console.log(`🔗 Webhook endpoint: https://matt-gpt-slack-app-w7oce.ondigitalocean.app/slack/events`);
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