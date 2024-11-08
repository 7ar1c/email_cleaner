const express = require('express');
const { google } = require('googleapis');
const session = require('express-session');
const { Buffer } = require('buffer');  // Required for decoding base64
const cheerio = require('cheerio');     // For parsing HTML
require('dotenv').config();

const app = express();
const PORT = 3000;

// Replace these with your Google OAuth credentials
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI); //init instance of OAuth2

// Set up session for storing user tokens
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
}));

// Serve static files (our HTML page)
app.use(express.static('public'));

// Step 1: Direct user to Google OAuth 2.0 authorization
app.get('/auth', (req, res) => {
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/gmail.readonly'
    ]
  });
  res.redirect(authorizeUrl);
});

// Step 2: Handle OAuth 2.0 callback and store tokens in session
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    req.session.tokens = tokens;
    res.redirect('/');  // Redirect back to home after successful login
  } catch (error) {
    console.error('Error retrieving tokens:', error);
    res.status(500).send('Authentication failed');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});



app.get('/recent-emails', async (req, res) => {
  if (!req.session.tokens) return res.redirect('/auth');  // Redirect to /auth if not logged in
  
  oauth2Client.setCredentials(req.session.tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    let messages = [];
    let nextPageToken;
    const senderLinks = new Map();  // Map to store unique senders and their unsubscribe links

    // Loop to retrieve up to 1,000 emails containing "unsubscribe"
    do {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: 'unsubscribe',  // Search query for "unsubscribe"
        maxResults: 100,   // Gmail API limit per request
        pageToken: nextPageToken,
      });

      if (response.data.messages) {
        messages = messages.concat(response.data.messages);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken && messages.length < 1000);

    // Limit to 1,000 messages if more were retrieved
    messages = messages.slice(0, 1000);

    const emailPromises = messages.map(async (message) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
      });

      // Find the "From" header
      const fromHeader = msg.data.payload.headers.find(header => header.name === 'From');
      if (!fromHeader) return;

      const sender = fromHeader.value;

      // Check for parts in the email body and select the appropriate part
      const emailBodyPart = msg.data.payload.parts?.find(part => part.mimeType === 'text/html');
      if (!emailBodyPart || !emailBodyPart.body?.data) return;

      // Decode the email body
      const decodedBody = Buffer.from(emailBodyPart.body.data, 'base64').toString('utf-8');

      // Parse the decoded HTML to find links with "unsubscribe" as the link text
      const $ = cheerio.load(decodedBody);
      const unsubscribeLinks = [];

      $('a').each((i, el) => {
        if ($(el).text().toLowerCase().includes('unsubscribe')) {
          const link = $(el).attr('href');
          if (link) unsubscribeLinks.push(link);
        }
      });

      // If unsubscribe links are found, add them to the Map under the sender's name
      if (unsubscribeLinks.length > 0) {
        if (!senderLinks.has(sender)) {
          senderLinks.set(sender, new Set());
        }
        unsubscribeLinks.forEach(link => senderLinks.get(sender).add(link));
      }
    });

    // Wait for all messages to be processed
    await Promise.all(emailPromises);

    // Convert the Map to an array format and remove duplicate links
    const result = Array.from(senderLinks.entries()).map(([sender, links]) => ({
      sender,
      unsubscribeLinks: Array.from(links),  // Convert Set to Array to avoid duplicates
    }));

    // Return the result as JSON
    res.json(result);

  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).send('Failed to fetch recent emails');
  }
});

const MAX_RETRIES = 5;  // Max retries before giving up
const RETRY_DELAY = 10000; // Initial delay in milliseconds (10 seconds)
const EXPONENTIAL_BACKOFF_MULTIPLIER = 2; // Exponential backoff multiplier

async function modifyEmailWithRetry(gmail, messageId, labelId, retries = 0) {
  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: [labelId],  // Add the label to the email
        removeLabelIds: ['INBOX'],      // label to remove
      },
    });
  } catch (error) {
    if (error.response && error.response.status === 429 && retries < MAX_RETRIES) {
      // Retry if rate limit exceeded and retries are available
      console.log(`Rate limit exceeded. Retrying in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY)); // Wait before retrying
      return modifyEmailWithRetry(gmail, messageId, labelId, retries + 1);
    } else if (retries >= MAX_RETRIES) {
      console.error(`Max retries reached for message ${messageId}. Giving up.`);
      throw new Error(`Failed to modify message ${messageId} after ${MAX_RETRIES} retries`);
    } else {
      // Rethrow other errors (e.g., network issues, other HTTP errors)
      throw error;
    }
  }
}

app.get('/move-emails', async (req, res) => {
  if (!req.session.tokens) return res.redirect('/auth');  // Redirect to /auth if not logged in

  oauth2Client.setCredentials(req.session.tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // 1. Search for emails containing the word 'unsubscribe'
    let messages = [];
    let nextPageToken;

    do {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: 'unsubscribe',  // Search query for "unsubscribe"
        maxResults: 100,   // Gmail API limit per request
        pageToken: nextPageToken,
      });

      if (response.data.messages) {
        messages = messages.concat(response.data.messages);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken && messages.length < 10000);  // Limiting to 1000 emails

    // If no emails found
    if (messages.length === 0) {
      return res.status(404).send('No emails found containing "unsubscribe".');
    }

    // 2. Create or find the label where you want to move the emails
    let labelId;
    try {
      const labels = await gmail.users.labels.list({
        userId: 'me',
      });

      // Look for the label by name (e.g., "Unsubscribe")
      const label = labels.data.labels.find(l => l.name === 'junkyjunk');
      if (label) {
        labelId = label.id;
      } else {
        // If the label doesn't exist, create it
        const newLabel = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: 'junkyjunk',
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          },
        });
        labelId = newLabel.data.id;
      }
    } catch (err) {
      return res.status(500).send('Failed to create or retrieve label');
    }

    // 3. Apply the label to all emails containing "unsubscribe" with rate limiting and retries
    const emailPromises = [];
    const BATCH_SIZE = 5;  // Number of emails to process in each batch
    const DELAY = 1000;     // Delay in milliseconds between batches

    const processBatch = async (batch) => {
      try {
        await Promise.all(batch.map(async (message) => {
          try {
            await modifyEmailWithRetry(gmail, message.id, labelId);
          } catch (err) {
            console.error(`Failed to modify message ${message.id} after retries:`, err);
          }
        }));
      } catch (err) {
        console.error('Error processing batch:', err);
      }
    };

    // Loop through the emails in batches and apply the label with rate limiting
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);

      // Use a delay to respect rate limits and batch processing
      const batchPromise = new Promise((resolve) => {
        setTimeout(async () => {
          try {
            await processBatch(batch);
            resolve();  // Resolve when the batch is processed
          } catch (err) {
            console.error('Error in batch:', err);
            resolve();  // Ensure we resolve even if there's an error
          }
        }, DELAY * (i / BATCH_SIZE));  // Apply delay between batches
      });

      emailPromises.push(batchPromise);
    }

    // Wait for all batches to be processed
    await Promise.all(emailPromises);

    res.send('Emails with "unsubscribe" have been labeled.');
  } catch (error) {
    console.error('Error moving emails:', error);
    res.status(500).send('Failed to move emails under the label');
  }
});


