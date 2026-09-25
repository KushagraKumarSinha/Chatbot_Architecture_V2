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