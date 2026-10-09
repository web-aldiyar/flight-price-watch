export interface IncomingMessage {
  chatId: number;
  text: string;
}

export interface Messenger {
  send(chatId: number, text: string): Promise<void>;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

/** Minimal Telegram Bot API client (long polling), no dependencies. */
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

  async send(chatId: number, text: string): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  /** Long-polls for text messages until the signal is aborted. */
  async *messages(signal: AbortSignal): AsyncGenerator<IncomingMessage> {
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await this.call<Update[]>(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ['message'] },
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
        const text = update.message?.text;
        if (update.message && text) yield { chatId: update.message.chat.id, text };
      }
    }
  }
}
