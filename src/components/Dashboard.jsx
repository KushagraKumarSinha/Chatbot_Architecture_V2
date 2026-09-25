import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { readConversations, createConversation, deleteConversation } from "../apicalls/conversationapis.js";

export default function Dashboard() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");

  const inputRef = useRef(null);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      try {
        const ret = await readConversations();
        if (isMounted) setData(ret?.conversations || []);
      } catch (err) {
        console.error("Failed to load conversations:", err.message);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchData();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (isModalOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isModalOpen]);

  const openCreateModal = () => {
    const defaultTitle = `New Chat - ${new Date().toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })}`;
    setModalTitle(defaultTitle);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    if (creating) return;
    setIsModalOpen(false);
    setModalTitle("");
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    const finalTitle = modalTitle.trim();
    if (!finalTitle || creating) return;

    setCreating(true);
    try {
      const conversation = await createConversation(finalTitle);
      const conversationId = conversation?.id || conversation?._id;

      closeModal();
      navigate("/ChatComponent", {
        state: { conversationID: conversationId },
      });
    } catch (err) {
      console.error("Failed to create conversation:", err.message);
    } finally {
      setCreating(false);
    }
  };

  const openConversation = (id) => {
    navigate("/ChatComponent", { state: { conversationID: id } });
  };

  const handleDelete = async (e, id, title) => {
    e.stopPropagation(); // don't trigger openConversation
    if (deletingId) return;

    const confirmed = window.confirm("Delete this conversation? This can't be undone.");
    if (!confirmed) return;

    setDeletingId(id);
    try {
      await deleteConversation(id, title);
      setData((prev) => prev.filter((c) => (c.id || c._id) !== id));
    } catch (err) {
      console.error("Failed to delete conversation:", err.message);
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <main className="max-w-6xl mx-auto px-4 py-10">
        <div className="flex justify-between items-center mb-8">
          <div className="h-8 w-44 bg-gray-200 rounded-md animate-pulse" />
          <div className="h-10 w-36 bg-gray-200 rounded-lg animate-pulse" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-32 bg-white border border-gray-200/80 rounded-xl p-5 animate-pulse"
            />
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-10 relative">
      <header className="flex items-center justify-between pb-6 border-b border-gray-200/70 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            {user?.name ? `Welcome, ${user.name}` : "Conversations"}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Pick up where you left off or start a fresh session.
          </p>
        </div>

        {data.length > 0 && (
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold py-2.5 px-4 rounded-lg transition shadow-xs hover:shadow cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            New Chat
          </button>
        )}
      </header>

      {data.length === 0 ? (
        <section className="flex flex-col items-center justify-center py-16 px-4 text-center bg-gray-50/70 border border-dashed border-gray-200 rounded-2xl max-w-xl mx-auto">
          <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 mb-4 shadow-xs">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">
            No conversations yet
          </h2>
          <p className="text-sm text-gray-500 mb-6">
            Start a new thread to explore topics, organize notes, or brainstorm solutions.
          </p>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-medium py-2.5 px-5 rounded-lg shadow-xs transition cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            Start Conversation
          </button>
        </section>
      ) : (
        <section>
          <div className="flex items-center justify-between mb-4 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Recent Activity
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {data.map((conv) => {
              const id = conv.id || conv._id;
              const isDeleting = deletingId === id;
              const title = conv.title

              return (
                <div
                  key={id}
                  onClick={() => openConversation(id)}
                  className="group relative flex flex-col justify-between text-left h-36 bg-white hover:bg-blue-50/20 border border-gray-200 hover:border-blue-400 rounded-xl p-4 transition-all duration-150 shadow-xs hover:shadow-md cursor-pointer"
                >
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, id, title)}
                    disabled={isDeleting}
                    aria-label="Delete conversation"
                    className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-lg text-gray-300 opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 transition-all disabled:opacity-50 cursor-pointer z-10"
                  >
                    {isDeleting ? (
                      <span className="w-3.5 h-3.5 border-2 border-red-300/40 border-t-red-500 rounded-full animate-spin" />
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.8}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    )}
                  </button>

                  <div className="flex items-center justify-between w-full">
                    <div className="w-8 h-8 rounded-lg bg-gray-100 group-hover:bg-blue-100 text-gray-500 group-hover:text-blue-600 flex items-center justify-center transition-colors">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.8}
                          d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                        />
                      </svg>
                    </div>
                    <svg
                      className="w-4 h-4 text-gray-300 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>

                  <div className="w-full">
                    <h3 className="font-semibold text-gray-800 group-hover:text-blue-600 text-sm line-clamp-2 leading-snug pr-6">
                      {conv.title || "Untitled Conversation"}
                    </h3>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-in fade-in duration-150"
          onKeyDown={(e) => e.key === "Escape" && closeModal()}
        >
          <div className="fixed inset-0" onClick={closeModal} />

          <div className="relative w-full max-w-md bg-white rounded-2xl p-6 shadow-xl border border-gray-100 z-10">
            <h3 className="text-lg font-semibold text-gray-900">
              Name your conversation
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              Give this session a title so you can easily reference it later.
            </p>

            <form onSubmit={handleFormSubmit} className="mt-5">
              <input
                ref={inputRef}
                type="text"
                value={modalTitle}
                onChange={(e) => setModalTitle(e.target.value)}
                placeholder="e.g. System Architecture Notes"
                className="w-full px-3.5 py-2.5 text-sm text-gray-900 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 transition"
                required
                maxLength={80}
              />

              <div className="flex items-center justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={creating}
                  className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition disabled:opacity-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !modalTitle.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg shadow-xs transition disabled:opacity-50 cursor-pointer"
                >
                  {creating && (
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}