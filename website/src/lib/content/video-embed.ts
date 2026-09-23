/** Only these two video providers are rendered in an iframe. Other embeds remain links. */
export function trustedVideoEmbedUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "youtu.be" && segments.length === 1) {
    return youtubeEmbed(segments[0]);
  }
  if (host === "youtube.com" || host === "www.youtube.com" || host === "www.youtube-nocookie.com") {
    if (segments.length === 1 && segments[0] === "watch") {
      return youtubeEmbed(url.searchParams.get("v") ?? undefined);
    }
    if (segments.length === 2 && ["embed", "shorts", "live"].includes(segments[0] ?? "")) {
      return youtubeEmbed(segments[1]);
    }
  }
  if (host === "vimeo.com" || host === "www.vimeo.com") {
    if (segments.length === 1) return vimeoEmbed(segments[0], url.searchParams.get("h"));
  }
  if (host === "player.vimeo.com" && segments.length === 2 && segments[0] === "video") {
    return vimeoEmbed(segments[1], url.searchParams.get("h"));
  }
  return undefined;
}

function youtubeEmbed(id: string | undefined): string | undefined {
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return undefined;
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

function vimeoEmbed(id: string | undefined, hash: string | null): string | undefined {
  if (!id || !/^\d{1,20}$/.test(id)) return undefined;
  if (hash && !/^[a-fA-F0-9]{8,64}$/.test(hash)) return undefined;
  return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`;
}
