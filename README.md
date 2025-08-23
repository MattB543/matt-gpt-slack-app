# Matt's GPT Slack Bot

A production-ready Slack bot that integrates with Matt-GPT API using the Bolt JavaScript SDK. The bot monitors messages in specified channels and responds with AI-generated responses, featuring comprehensive error handling, thread support, retry logic, and intelligent conversation tracking.

## Features

- 🤖 **Matt-GPT Integration**: Powered by Claude 3.5 Sonnet via Matt's GPT API
- 💬 **Smart Thread Support**: Maintains conversation context automatically using Slack message metadata
- 🆔 **Conversation Tracking**: No database needed - stores conversation IDs in Slack message blocks
- 🎯 **Channel Filtering**: Configure specific channels to monitor
- 🔄 **Retry Logic**: Robust handling of API timeouts and failures
- 🛡️ **Error Handling**: Comprehensive error handling for production use
- 🔌 **Socket Mode**: Easy development setup without public URLs
- ⚡ **Real-time Updates**: Processing indicators with live message updates

## Prerequisites

- **Node.js**: Version 18 or higher
- **npm**: Version 8.6.0 or higher  
- **Slack Workspace**: Admin access to create and configure apps
- **Matt-GPT API**: Access to Matt's GPT API with bearer token

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd matt-gpt-slack-app
npm install
```

### 2. Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Name your app and select your workspace

#### Configure OAuth Scopes

Navigate to **OAuth & Permissions** and add these Bot Token Scopes:

```
channels:history    # Read messages from public channels
groups:history      # Read messages from private channels  
im:history          # Read messages from DMs
mpim:history        # Read messages from group DMs
chat:write          # Send messages
```

#### Enable Event Subscriptions

1. Go to **Event Subscriptions** and toggle "Enable Events"
2. Set Request URL to: `https://your-domain.com/slack/events`
3. Add these Bot Events:
   - `message.channels`
   - `message.groups` 
   - `message.im`
   - `message.mpim`
   - `app_mention`

#### Install to Workspace

1. Go to **OAuth & Permissions**
2. Click "Install to Workspace"  
3. Copy the Bot User OAuth Token (starts with `xoxb-`)

#### Get Signing Secret

1. Go to **Basic Information**
2. Copy the Signing Secret from "App Credentials"

### 3. Environment Configuration

Create a `.env` file from the sample:

```bash
cp .env.sample .env
```

Fill in your configuration:

```env
# Slack Bot Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
SLACK_CHANNEL_ID=C1234567890  # Optional: specific channel to monitor

# Matt-GPT API Configuration  
MATT_GPT_API_URL=http://localhost:8000
MATT_GPT_BEARER_TOKEN=your-bearer-token-here

# Server Configuration
PORT=3000
```

#### Finding Channel IDs

To find a Slack channel ID:
1. Right-click the channel name → "Copy Link"
2. Extract the ID from the URL: `https://app.slack.com/client/WORKSPACE/C1234567890`
3. The channel ID is `C1234567890`

### 4. Run the Bot

```bash
# Development with auto-restart
npm run dev

# Production
npm start
```

## Usage

### Basic Interaction

1. **Invite the bot** to channels where you want it to respond:
   ```
   /invite @your-bot-name
   ```

2. **Send any message** in the monitored channel and the bot will respond with ChatGPT

3. **Thread conversations** are automatically maintained - replies stay in the same thread

### Example Interaction

```
User: How do I center a div in CSS?

Bot: 🤔 Thinking...
      
Bot: To center a div in CSS, you can use several methods:

**Flexbox (recommended):**
```css
.container {
  display: flex;
  justify-content: center;
  align-items: center;
}
```

**CSS Grid:**
```css  
.container {
  display: grid;
  place-items: center;
}
```

This creates a clean, modern solution that works across all modern browsers.

User: What about vertical centering only?

Bot: For vertical centering only, you can use:

**Flexbox:**
```css
.container {
  display: flex;
  align-items: center;
}
```

The conversation context is automatically maintained within the thread!
```

## Configuration Options

### Channel Filtering

- **Monitor specific channel**: Set `SLACK_CHANNEL_ID` in `.env`
- **Monitor all channels**: Leave `SLACK_CHANNEL_ID` empty (bot must be invited to channels)

### Matt-GPT API Settings

The bot connects to Matt-GPT API with these settings:
- **Model**: Claude 3.5 Sonnet (anthropic/claude-3.5-sonnet)
- **Timeout**: 30 seconds
- **Retry attempts**: 3 with exponential backoff
- **Conversation tracking**: Automatic via Slack message metadata

To modify these, edit the `callMattGPTWithRetry` function in `app.js`.

### Conversation Tracking

The bot automatically maintains conversation context using a clever approach:
- **No Database Required**: Conversation IDs are stored directly in Slack message metadata
- **Block ID Storage**: Each bot response includes a hidden block with the conversation ID  
- **Thread Continuity**: When replying in threads, the bot searches previous messages for existing conversation IDs
- **Automatic Context**: Matt-GPT API receives the conversation ID to maintain context across messages

## Architecture

### File Structure

```
matt-gpt-slack-app/
├── .env                # Environment variables (create from .env.sample)
├── .env.sample        # Environment template
├── .gitignore         # Git ignore rules
├── package.json       # Dependencies and scripts  
├── app.js            # Main application
├── claude/           # Documentation
└── README.md         # This file
```

### Key Components

- **Message Handler**: Filters and processes incoming messages with conversation tracking
- **Thread System**: Maintains conversation context using `thread_ts` and conversation IDs
- **Matt-GPT Integration**: Calls Matt-GPT API with retry logic and context passing
- **Conversation Tracking**: Stores and retrieves conversation IDs from Slack message metadata
- **Error Handling**: Global and specific error handling
- **Configuration Validation**: Startup checks for required environment variables

## Development

### Events API for Production

This bot uses **Events API** for production deployment:
- ✅ Better scalability and reliability
- ✅ Suitable for production environments
- ✅ Stateless HTTP connections
- ⚠️ Requires public HTTPS endpoint
- ⚠️ Must configure webhook URL in Slack app

**Deployment Requirements:**
- Public HTTPS endpoint at `/slack/events`
- Valid SSL certificate
- Webhook URL configured in Slack app settings

### Adding Features

The modular structure makes it easy to add features:

```javascript
// Add a new command handler
app.message(/^!weather (.+)/, async ({ context, say, message }) => {
  const location = context.matches[1];
  const conversationId = extractConversationId(message) || uuidv4();
  
  // Call weather API and Matt-GPT for contextual response
  const apiContext = { conversation_id: conversationId };
  const response = await callMattGPTWithRetry(
    `Get weather for ${location}`, 
    apiContext, 
    3, 
    logger
  );
  
  await say(createMessageWithConversationId(
    response.response, 
    conversationId, 
    message.thread_ts || message.ts
  ));
});

// Add reaction handling  
app.event('reaction_added', async ({ event, say }) => {
  // Handle emoji reactions with conversation context
});
```

## Error Handling

The bot includes comprehensive error handling:

### User-Facing Errors
- ⏰ **Timeout**: "Request timed out. Please try again."
- 🚦 **Rate Limiting**: "Service is busy. Please wait a moment." 
- 🤖 **API Issues**: "Matt-GPT is temporarily unavailable."
- ❌ **General**: "Something went wrong. Please try again."

### System Errors
- Missing OAuth scopes
- Authentication failures
- Network connectivity issues
- Channel access problems

Check the console logs for detailed error information.

## Troubleshooting

### Common Issues

**Bot not responding to messages:**
- Ensure bot is invited to the channel: `/invite @your-bot-name`
- Check `SLACK_CHANNEL_ID` matches the channel you're testing in
- Verify OAuth scopes include `channels:history` and `chat:write`

**"Missing scope" errors:**
- Go to OAuth & Permissions in your Slack app
- Add the required scopes listed in the error
- Reinstall the app to workspace

**Matt-GPT API not working:**
- Verify `MATT_GPT_BEARER_TOKEN` is set correctly
- Check `MATT_GPT_API_URL` points to the correct endpoint
- Ensure the API is running and accessible
- Verify your bearer token has proper permissions

**Authentication errors:**
- Verify bot token starts with `xoxb-`
- Regenerate tokens if they're old
- Check signing secret matches exactly
- Ensure Events API is properly configured with correct webhook URL

### Debug Mode

Enable verbose logging:

```javascript
// Add to top of app.js
process.env.SLACK_LOG_LEVEL = 'debug';
```

### Testing Configuration

Test your setup without starting the full bot:

```bash
node -e "
require('dotenv').config();
console.log('Bot Token:', process.env.SLACK_BOT_TOKEN ? 'Set ✅' : 'Missing ❌');
console.log('Signing Secret:', process.env.SLACK_SIGNING_SECRET ? 'Set ✅' : 'Missing ❌');
console.log('Matt-GPT Token:', process.env.MATT_GPT_BEARER_TOKEN ? 'Set ✅' : 'Missing ❌');
console.log('Matt-GPT URL:', process.env.MATT_GPT_API_URL || 'Using default: http://localhost:8000');
"
```

## Production Deployment

For production deployment:

1. **Environment Variables**: Set all required env vars on your hosting platform
2. **Process Management**: Use PM2 or similar for process management
3. **Monitoring**: Implement health checks and error reporting
4. **Scaling**: Consider Events API for higher throughput
5. **Security**: Use proper secret management (not .env files)

### Example PM2 Configuration

```javascript  
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'slack-bot',
    script: 'app.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
}
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable  
5. Submit a pull request

## License

ISC License - see LICENSE file for details.

## Support

For issues and questions:
- Check the troubleshooting section above
- Review Slack Bolt documentation: [slack.dev/bolt-js](https://slack.dev/bolt-js)
- Check OpenAI API documentation: [platform.openai.com/docs](https://platform.openai.com/docs)