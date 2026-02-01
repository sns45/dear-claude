/**
 * Gmail Adapter
 * Handles Gmail via Google Cloud Pub/Sub and Gmail API
 */

import type { Context } from "hono";
import type { PlatformAdapter, PlatformEvent, AdapterConfig } from "./platform-adapter.js";

interface GmailPubSubMessage {
  message: {
    data: string;  // Base64 encoded
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

interface GmailNotification {
  emailAddress: string;
  historyId: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
    }>;
  };
  internalDate: string;
}

export class GmailAdapter implements PlatformAdapter {
  readonly platform = "gmail" as const;
  private config: AdapterConfig & {
    pubsubTopic?: string;
    pubsubSubscription?: string;
  };
  private apiUrl = "https://gmail.googleapis.com/gmail/v1";
  private authUrl = "https://accounts.google.com/o/oauth2/v2/auth";
  private tokenUrl = "https://oauth2.googleapis.com/token";

  constructor(config: AdapterConfig & { pubsubTopic?: string; pubsubSubscription?: string }) {
    this.config = config;
  }

  isConfigured(): boolean {
    return !!(this.config.accessToken || (this.config.clientId && this.config.clientSecret));
  }

  async verifySignature(ctx: Context, body: string): Promise<boolean> {
    // Google Pub/Sub uses push authentication via OAuth or JWT
    // For simplicity, we verify the message format and trust Cloud Pub/Sub
    const authHeader = ctx.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      console.warn("[GmailAdapter] Missing or invalid authorization header");
      // In production, verify the JWT token
      // For now, accept if it's a valid Pub/Sub message format
    }
    return true;
  }

  async parseWebhook(ctx: Context, body: unknown): Promise<PlatformEvent | null> {
    const pubsubMessage = body as GmailPubSubMessage;

    if (!pubsubMessage.message?.data) {
      console.warn("[GmailAdapter] Invalid Pub/Sub message format");
      return null;
    }

    // Decode the base64 notification
    const notificationData = Buffer.from(pubsubMessage.message.data, "base64").toString();
    const notification = JSON.parse(notificationData) as GmailNotification;

    console.log(`[GmailAdapter] Received notification for ${notification.emailAddress}, historyId: ${notification.historyId}`);

    // Fetch the actual message content using history API
    // This requires an access token and is done in processNotification
    return {
      platform: "gmail",
      threadId: notification.historyId,  // Will be replaced with actual threadId after fetching
      content: "",  // Will be filled after fetching message
      isDescription: true,  // Will be determined after checking thread
      raw: notification
    };
  }

  /**
   * Process a Gmail notification by fetching the actual message
   */
  async processNotification(historyId: string, startHistoryId?: string): Promise<PlatformEvent[]> {
    if (!this.config.accessToken) {
      throw new Error("Gmail access token not configured");
    }

    const events: PlatformEvent[] = [];

    // Get history since last known historyId
    const historyUrl = `${this.apiUrl}/users/me/history?startHistoryId=${startHistoryId || historyId}&historyTypes=messageAdded`;

    const historyResponse = await fetch(historyUrl, {
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`
      }
    });

    if (!historyResponse.ok) {
      const error = await historyResponse.text();
      throw new Error(`Failed to fetch history: ${error}`);
    }

    const historyData = await historyResponse.json() as {
      history?: Array<{
        messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
      }>;
    };

    if (!historyData.history) {
      return events;
    }

    // Process each new message
    for (const historyItem of historyData.history) {
      if (!historyItem.messagesAdded) continue;

      for (const added of historyItem.messagesAdded) {
        const message = await this.getMessage(added.message.id);
        if (!message) continue;

        // Check if this is the first message in the thread
        const threadMessages = await this.getThreadMessages(message.threadId);
        const isFirstInThread = threadMessages.length === 1;

        const content = this.extractMessageContent(message);
        const subject = this.getHeader(message, "Subject") || "";
        const from = this.getHeader(message, "From") || "";

        events.push({
          platform: "gmail",
          threadId: message.threadId,
          content: `${subject}\n${content}`,
          isDescription: isFirstInThread,
          messageId: message.id,
          authorId: from,
          raw: message
        });
      }
    }

    return events;
  }

  private async getMessage(messageId: string): Promise<GmailMessage | null> {
    const response = await fetch(`${this.apiUrl}/users/me/messages/${messageId}?format=full`, {
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`
      }
    });

    if (!response.ok) {
      console.error(`[GmailAdapter] Failed to fetch message ${messageId}`);
      return null;
    }

    return response.json() as Promise<GmailMessage>;
  }

  private async getThreadMessages(threadId: string): Promise<GmailMessage[]> {
    const response = await fetch(`${this.apiUrl}/users/me/threads/${threadId}?format=metadata`, {
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`
      }
    });

    if (!response.ok) {
      return [];
    }

    const thread = await response.json() as { messages?: GmailMessage[] };
    return thread.messages || [];
  }

  private getHeader(message: GmailMessage, name: string): string | undefined {
    return message.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
  }

  private extractMessageContent(message: GmailMessage): string {
    // Try to get plain text body
    if (message.payload.body?.data) {
      return Buffer.from(message.payload.body.data, "base64").toString();
    }

    // Check parts for text/plain
    if (message.payload.parts) {
      for (const part of message.payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString();
        }
      }
    }

    // Fall back to snippet
    return message.snippet || "";
  }

  async postResponse(threadId: string, message: string): Promise<void> {
    if (!this.config.accessToken) {
      throw new Error("Gmail access token not configured");
    }

    // Get the original message to reply to
    const threadMessages = await this.getThreadMessages(threadId);
    if (threadMessages.length === 0) {
      throw new Error(`Thread ${threadId} not found`);
    }

    const originalMessage = threadMessages[threadMessages.length - 1];
    const originalMessageId = this.getHeader(originalMessage, "Message-ID");
    const subject = this.getHeader(originalMessage, "Subject") || "";
    const to = this.getHeader(originalMessage, "From") || "";

    // Build RFC 2822 email
    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
    const email = [
      `To: ${to}`,
      `Subject: ${replySubject}`,
      `In-Reply-To: ${originalMessageId}`,
      `References: ${originalMessageId}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      message
    ].join("\r\n");

    const encodedEmail = Buffer.from(email).toString("base64url");

    const response = await fetch(`${this.apiUrl}/users/me/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        raw: encodedEmail,
        threadId
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send reply: ${error}`);
    }

    console.log(`[GmailAdapter] Sent reply to thread ${threadId}`);
  }

  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify",
      state,
      access_type: "offline",
      prompt: "consent"
    });

    return `${this.authUrl}?${params.toString()}`;
  }

  async handleCallback(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string }> {
    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        redirect_uri: redirectUri,
        code
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code: ${error}`);
    }

    const data = await response.json() as { access_token: string; refresh_token?: string };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token
    };
  }

  /**
   * Set up Gmail push notifications via Pub/Sub
   */
  async setupPushNotifications(topicName: string): Promise<{ historyId: string; expiration: string }> {
    if (!this.config.accessToken) {
      throw new Error("Gmail access token not configured");
    }

    const response = await fetch(`${this.apiUrl}/users/me/watch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        topicName,
        labelIds: ["INBOX"]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to setup watch: ${error}`);
    }

    const data = await response.json() as { historyId: string; expiration: string };
    console.log(`[GmailAdapter] Watch setup, historyId: ${data.historyId}, expires: ${data.expiration}`);

    return data;
  }
}
