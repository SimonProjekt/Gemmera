/**
 * Static help response rendered when the classifier routes a turn to `meta`.
 *
 * The text is kept in a dedicated module so the orchestrator does not inline
 * prose and the content can be iterated independently of routing logic.
 *
 * #79
 */

export const META_HELP_RESPONSE = [
  "I'm Gemmera, your vault assistant. Here's what I can do:",
  "",
  "**Capture** — Save your thoughts, meeting notes, or selections as structured notes.",
  '  • Type normally and press Enter, or use "Ctrl+Enter" to force capture.',
  "  • Attach files (PDF, image, audio, text) and I'll include them.",
  "",
  "**Ask** — Search your vault and answer questions using your notes.",
  '  • Start your message with "?" to force a question.',
  "  • I'll cite the notes I used so you can verify.",
  "",
  "**Mixed** — I'll save what you're sharing, then answer your question",
  "  using the newly saved note plus your existing vault.",
  "",
  "**Commands** — Right-click on a note or selection in the editor for quick actions.",
  "",
  "For more details, check the Gemmera settings tab.",
].join("\n");
