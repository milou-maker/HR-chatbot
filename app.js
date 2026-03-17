import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/slack/events', async (req, res) => {
  const { type, event } = req.body;

  if (type === 'url_verification') return res.json({ challenge: req.body.challenge });

  if (event?.type === 'app_mention' || event?.type === 'message') {
    if (event.bot_id) return res.sendStatus(200);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: 'You are a helpful HR assistant. Answer questions about company policies, benefits, time off, onboarding, and HR topics. Be warm and concise. If a question is sensitive (harassment, grievance, legal) or you cannot answer, say you will loop in the HR team.',
      messages: [{ role: 'user', content: event.text }]
    });

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ channel: event.channel, text: message.content[0].text })
    });
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`HR bot listening on port ${PORT}`));
