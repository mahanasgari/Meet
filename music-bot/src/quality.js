// yt-dlp format for /audio. "low" is the data saver (about 50-70 kbps on
// YouTube); anything else is the best audio available.
export function audioFormat(q) {
  return q === "low" ? "bestaudio[abr<=70]/worstaudio/bestaudio" : "bestaudio/best";
}
