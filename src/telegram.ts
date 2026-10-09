export type Incoming =
  | { kind: 'text'; chatId: number; text: string }
  | { kind: 'button'; chatId: number; data: string; callbackId: string };

export interface InlineButton {
  text: string;
  /** Sent back as callback data when pressed (max 64 bytes). */
  data: string;
}

export interface SendOptions {
  /** Buttons attached to the message. */
  buttons?: InlineButton[][];
  /** Show the main menu keyboard under the input field. */
  menu?: string[][];
}

export interface Messenger {
  send(chatId: number, text: string, options?: SendOptions): Promise<void>;
}

export interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

export const ALLOWED_UPDATES = ['message', 'callback_query'];

/** A text message or a button press carried by an update, if any. */
export function parseUpdate(update: Update): Incoming | null {
  const text = update.message?.text;
  if (update.message && text) return { kind: 'text', chatId: update.message.chat.id, text };

  const query = update.callback_query;
  if (query?.data && query.message) {
    return { kind: 'button', chatId: query.message.chat.id, data: query.data, callbackId: query.id };
  }
  return null;
}

/** Minimal Telegram Bot API client (webhook or long polling), no dependencies. */
export class TelegramBot implements Messenger {
  private offset = 0;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(token: string, fetchFn: typeof fetch = fetch) {
    this.fetchFn = fetchFn;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, payload: object, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const body = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description ?? response.status}`);
    return body.result;
  }

  async send(chatId: number, text: string, options: SendOptions = {}): Promise<void> {
    let replyMarkup: object | undefined;
    if (options.buttons) {
      replyMarkup = {
        inline_keyboard: options.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
      };
    } else if (options.menu) {
      replyMarkup = {
        keyboard: options.menu.map((row) => row.map((text) => ({ text }))),
        resize_keyboard: true,
        is_persistent: true,
      };
    }
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    });
  }

  /** Stops the loading spinner on a pressed button. */
  async answerButton(callbackId: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId });
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ALLOWED_UPDATES });
  }

  /** Long-polls for messages and button presses until the signal is aborted. */
  async *updates(signal: AbortSignal): AsyncGenerator<Incoming> {
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await this.call<Update[]>(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ALLOWED_UPDATES },
          signal,
        );
      } catch (error) {
        if (signal.aborted) return;
        console.error('getUpdates failed, retrying in 5s:', error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      for (const update of updates) {
        this.offset = update.update_id + 1;
        const incoming = parseUpdate(update);
        if (incoming) yield incoming;
      }
    }
  }
}
