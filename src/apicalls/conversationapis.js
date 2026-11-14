import { supabase } from "../SupabaseClient.js";

export async function readConversations() {
  const { data, error } = await supabase.functions.invoke(
    'chat-endpoint',
    {
      body: {
        method: 'READ',
        function_name: 'read-conversation',
        payload: {}
      }
    }
  );

  if (error) throw error;
  return data;
}


export async function createConversation(title) {
  const { data, error } = await supabase.functions.invoke(
    'chat-endpoint',
    {
      body: {
        method: 'CREATE',
        function_name: 'create-conversation',
        payload: { title },
      },
    }
  );

  if (error) throw error;
  return data.conversation;
}


// Non-streaming version (kept for anything else that still uses it).
export async function chatwithLLM(conversation_id, message) {
  const { data, error } = await supabase.functions.invoke(
    'chat-endpoint',
    {
      body: {
        method: 'UPDATE',
        function_name: 'chat-conversation',
        payload: { conversation_id, message},
      },
    }
  );

  if (error) throw error;
  return data;
}


//Streaming version of chatwithLLM.
export async function chatwithLLMStream(conversation_id, message, { onDelta } = {}) {
  const { data, error } = await supabase.functions.invoke(
    'chat-endpoint',
    {
      body: {
        method: 'UPDATE',
        function_name: 'chat-conversation',
        payload: { conversation_id, message },
      },
    }
  );

  if (error) throw error;

  // supabase-js returns the raw Response for text/event-stream.
  const isStream = data && typeof data === 'object' && typeof data.body?.getReader === 'function';
  const isSseText = typeof data === 'string';

  // Plain JSON path (cache hit).
  if (!isStream && !isSseText) return data;

  let result = null;

  // Parses one SSE frame ("data: {...}"). Throws on server-reported errors.
  const handleFrame = (frame) => {
    const payload = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!payload) return;

    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }

    if (evt.type === 'delta' && typeof evt.text === 'string') {
      onDelta?.(evt.text);
    } else if (evt.type === 'done') {
      result = { reply: evt.reply, latency: evt.latency };
    } else if (evt.type === 'error') {
      throw new Error(evt.message || 'Streaming failed');
    }
  };

  const drain = (buffer) => {
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      handleFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
    return buffer;
  };

  if (isSseText) {
    // Older supabase-js versions buffer the whole body as text (no live
    // streaming, but still works). Upgrade @supabase/supabase-js to stream.
    drain(data.replace(/\r\n/g, '\n') + '\n\n');
  } else {
    const reader = data.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      buffer = drain(buffer);
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n');
    drain(buffer + '\n\n');
  }

  if (!result) throw new Error('Stream ended before the response completed');
  return result;
}

export async function getPastMessages(conversation_id) {
  const { data, error } = await supabase.functions.invoke(
    'chat-endpoint',
    {
      body: {
        method: 'READ',
        function_name: 'get-past-conversations',
        payload: { conversation_id},
      },
    }
  );

  if (error) throw error;
  return data;
}

export async function deleteConversation(conversation_id, title) {
  const { data, error } = await supabase.functions.invoke(
    'chat-endpoint',
    {
      body: {
        method: 'DELETE',
        function_name: 'delete-conversation',
        payload: { conversation_id, title},
      },
    }
  );

  if (error) throw error;
  return data;
}
