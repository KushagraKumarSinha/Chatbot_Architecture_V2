import { HandlerFn } from "./types.ts";
import {sql} from "./db.ts"

export const deleteConversation: HandlerFn = async (payload, ctx) => {
  if (!ctx.userId) {
    return { status: 401, body: { error: "Unauthorized: no user found on request" } };
  }

  const conversationId = payload?.conversation_id;
  const title = payload?.title;

  if (!conversationId || typeof conversationId !== "string") {
    return { status: 400, body: { error: "A valid 'conversation_id' is required" } };
  }
  if (!title || typeof title !== "string" || !title.trim()) {
    return { status: 400, body: { error: "A non-empty 'title' string is required" } };
  }

  // Verify the conversation belongs to this user AND the title matches,
  // as a safety check before deleting
  /*const { data: conversation, error: convError } = await ctx.supabase
    .from("conversations")
    .select("id, title")
    .eq("id", conversationId)
    .eq("user_id", ctx.userId)
    .single();

  if (convError || !conversation) {
    return { status: 404, body: { error: "Conversation not found" } };
  }

  if (conversation.title !== title.trim()) {
    return { status: 409, body: { error: "Title does not match this conversation" } };
  }

  // Delete messages first (in case there's no ON DELETE CASCADE set up)
  const { error: messagesDeleteError } = await ctx.supabase
    .from("messages")
    .delete()
    .eq("conversation_id", conversationId);

  if (messagesDeleteError) {
    console.error("deleteConversation: failed to delete messages", messagesDeleteError);
    return { status: 500, body: { error: "Failed to delete conversation messages" } };
  }

  // Then delete the conversation itself
  const { error: convDeleteError } = await ctx.supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId)
    .eq("user_id", ctx.userId);

  if (convDeleteError) {
    console.error("deleteConversation: failed to delete conversation", convDeleteError);
    return { status: 500, body: { error: "Failed to delete conversation" } };
  }

  return { status: 200, body: { message: "Conversation deleted", conversation_id: conversationId } };*/
  const [conversation] = await sql`
    SELECT id, title
    FROM conversations
    WHERE id = ${conversationId} AND user_id = ${ctx.userId}
  `;

  if (!conversation) {
    return { status: 404, body: { error: "Conversation not found" } };
  }

  if (conversation.title !== title.trim()) {
    return { status: 409, body: { error: "Title does not match this conversation" } };
  }

  try {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM messages WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM conversations WHERE id = ${conversationId} AND user_id = ${ctx.userId}`;
    });

    return { status: 200, body: { success: true } };
  } catch (error) {
    console.error("deleteConversation error:", error);
    return { status: 500, body: { error: "Failed to delete conversation" } };
  }
};
