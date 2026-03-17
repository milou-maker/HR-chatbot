import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fetch pages directly from a Confluence space
async function getConfluenceContent(query) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  const spaceKey = process.env.CONFLUENCE_SPACE_KEY || 'PC';

  if (!baseUrl || !email || !token) {
    console.log('Confluence credentials not set');
    return '';
  }

  try {
    const auth = Buffer.from(`${email}:${token}`).toString('base64');

    // Search within the specific space using CQL
    const cql = `space="${spaceKey}" AND type=page AND text~"${query}"`;
    const searchUrl = `https://${baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=3&expand=body.storage`;

    const response = await fetch(searchUrl, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Confluence search failed:', response.status, errorText);
      return await getSpacePages(baseUrl, auth, spaceKey, query);
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      console.log('No search results, fetching all space pages instead');
      return await getSpacePages(baseUrl, auth, spaceKey, query);
    }

    const content = data.results.map(page => {
      const title = page.title;
      const body = page.body?.storage?.value
        ?.replace(/<[^>]+>/g, ' ')
        ?.replace(/\s+/g, ' ')
        ?.trim()
        ?.slice(0, 2000) || '';
      return `Page: ${title}\n${body}`;
    }).join('\n\n---\n\n');

    console.log(`Found ${data.results.length} Confluence page(s)`);
    return content;

  } catch (err) {
    console.error('Confluence error:', err.message);
    return '';
  }
}

// Fallback: fetch all pages from the space
async function getSpacePages(baseUrl, auth, spaceKey, query) {
  try {
    const url = `https://${baseUrl}/wiki/rest/api/content?spaceKey=${spaceKey}&type=page&limit=10&expand=body.storage`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('Space fetch failed:', response.status);
      return '';
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      console.log('No pages found in space:', spaceKey);
      return '';
    }

    const keywords = query.toLowerCase().split(' ').filter(w => w.length > 3);
    const relevant = data.results.filter(page =>
      keywords.some(kw => page.title.toLowerCase().includes(kw))
    );

    const pages = relevant.length > 0 ? relevant : data.results.slice(0, 3);

    const content = pages.map(page => {
      const body = page.body?.storage?.value
        ?.replace(/<[^>]+>/g, ' ')
        ?.replace(/\s+/g, ' ')
        ?.trim()
        ?.slice(0, 2000) || '';
      return `Page: ${page.title}\n${body}`;
    }).join('\n\n---\n\n');

    console.log(`Fetched ${pages.length} page(s) from space ${spaceKey}`);
    return content;

  } catch (err) {
    console.error('Space fetch error:', err.message);
    return '';
  }
}

// Handle incoming Slack events
app.post('/slack/events', async (req, res) => {
  const { type, event } = req.body;

  if (type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  if (event?.type === 'app_mention' || event?.type === 'message') {
    if (event.bot_id || event.subtype) return res.sendStatus(200);

    res.sendStatus(200);

    const userMessage = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!userMessage) return;

    console.log(`Received message: "${userMessage}"`);

    try {
      const confluenceContent = await getConfluenceContent(userMessage);

      let systemPrompt = `You are a helpful, warm HR assistant for Rentman. Answer employee questions about company policies, benefits, time off, onboarding, and HR topics. Be concise and friendly.

If a question is sensitive (harassment, grievance, legal, health emergency), always say: "I'm looping in the HR team who can help you directly."

If you cannot find a relevant answer, say: "I wasn't able to find a clear answer — I'm looping in the HR team to help you."`;

      if (confluenceContent) {
        systemPrompt += `\n\nUse the following information from the Rentman knowledge base to answer the question. Always prioritise this over general knowledge:\n\n${confluenceContent}`;
        console.log('Using Confluence content in response');
      } else {
        console.log('No Confluence content found, using general knowledge');
      }

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      const reply = message.content[0].text;

      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channel: event.channel,
          text: reply,
          thread_ts: event.thread_ts || event.ts
        })
      });

    } catch (err) {
      console.error('Error processing message:', err.message);

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

app.get('/', (req, res) => res.send('HR bot is running!'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`HR bot listening on port ${PORT}`));
