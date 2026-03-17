import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fetch relevant pages from Confluence based on the employee's question
async function searchConfluence(query) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;

  if (!baseUrl || !email || !token) {
    console.log('Confluence credentials not set, skipping knowledge base lookup');
    return '';
  }

  try {
    const auth = Buffer.from(`${email}:${token}`).toString('base64');

    // Search Confluence for relevant pages
    const searchUrl = `https://${baseUrl}/wiki/rest/api/content/search?cql=text~"${encodeURIComponent(query)}" AND type=page&limit=3&expand=body.storage`;

    const response = await fetch(searchUrl, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('Confluence search failed:', response.status);
      return '';
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      console.log('No Confluence pages found for query:', query);
      return '';
    }

    // Extract text content from the top results
    const content = data.results.map(page => {
      const title = page.title;
      // Strip HTML tags from the page body
      const body = page.body?.storage?.value
        ?.replace(/<[^>]+>/g, ' ')
        ?.replace(/\s+/g, ' ')
        ?.trim()
        ?.slice(0, 1500) || '';
      return `Page: ${title}\n${body}`;
    }).join('\n\n---\n\n');

    console.log(`Found ${data.results.length} Confluence page(s) for: "${query}"`);
    return content;

  } catch (err) {
    console.error('Confluence error:', err.message);
    return '';
  }
}

// Handle incoming Slack events
app.post('/slack/events', async (req, res) => {
  const { type, event } = req.body;

  // Slack verification challenge
  if (type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Handle messages — ignore bot's own messages to avoid loops
  if (event?.type === 'app_mention' || event?.type === 'message') {
    if (event.bot_id || event.subtype) return res.sendStatus(200);

    // Respond to Slack immediately to avoid timeout
    res.sendStatus(200);

    // Clean the message text (remove the @HR Assistant mention if present)
    const userMessage = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!userMessage) return;

    console.log(`Received message: "${userMessage}"`);

    try {
      // Step 1: Search Confluence for relevant information
      const confluenceContent = await searchConfluence(userMessage);

      // Step 2: Build the system prompt, including Confluence content if found
      let systemPrompt = `You are a helpful, warm HR assistant. Answer employee questions about company policies, benefits, time off, onboarding, and HR topics. Be concise and friendly.

If a question is sensitive (harassment, grievance, legal, health emergency), always say: "I'm looping in the HR team who can help you directly."

If you cannot find a relevant answer, say: "I wasn't able to find a clear answer — I'm looping in the HR team to help you."`;

      if (confluenceContent) {
        systemPrompt += `\n\nUse the following information from the company knowledge base to answer the question. Prioritise this over general knowledge:\n\n${confluenceContent}`;
      }

      // Step 3: Call Claude API
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      const reply = message.content[0].text;
      console.log(`Sending reply: "${reply.slice(0, 100)}..."`);

      // Step 4: Send reply back to Slack
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channel: event.channel,
          text: reply,
          thread_ts: event.thread_ts || event.ts // reply in thread if possible
        })
      });

    } catch (err) {
      console.error('Error processing message:', err.message);

      // Send a fallback message to Slack so the employee isn't left hanging
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channel: event.channel,
          text: "Sorry, I'm having trouble right now. Please contact HR directly or try again in a moment."
        })
      });
    }
  } else {
    res.sendStatus(200);
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('HR bot is running!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`HR bot listening on port ${PORT}`));
