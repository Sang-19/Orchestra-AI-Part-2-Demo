export interface ParsedSseMessage {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Buffered incremental SSE parser that handles network chunks splitting mid-line,
 * mid-event, or bundling multiple events in a single TCP read.
 */
export class SseStreamParser {
  private buffer = '';

  push(chunk: string): ParsedSseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const messages: ParsedSseMessage[] = [];

    let delimiterIdx = this.buffer.indexOf('\n\n');
    while (delimiterIdx !== -1) {
      const rawBlock = this.buffer.slice(0, delimiterIdx);
      this.buffer = this.buffer.slice(delimiterIdx + 2);

      const parsed = this.parseBlock(rawBlock);
      if (parsed) {
        messages.push(parsed);
      }

      delimiterIdx = this.buffer.indexOf('\n\n');
    }

    return messages;
  }

  flush(): ParsedSseMessage[] {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (!remaining) return [];
    const parsed = this.parseBlock(remaining);
    return parsed ? [parsed] : [];
  }

  private parseBlock(block: string): ParsedSseMessage | null {
    const lines = block.split('\n');
    let id: string | undefined;
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'id') {
        id = value;
      } else if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }

    if (dataLines.length === 0) return null;
    return {
      id,
      event,
      data: dataLines.join('\n'),
    };
  }
}
