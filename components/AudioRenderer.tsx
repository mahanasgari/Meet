"use client";

import { useEffect, useRef } from "react";
import type { Track } from "livekit-client";

function AudioTrack({ track }: { track: Track }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return <audio ref={audioRef} autoPlay />;
}

export function AudioRenderer({ tracks }: { tracks: Track[] }) {
  return (
    <div className="hidden">
      {tracks.map((track) => (
        <AudioTrack key={track.sid ?? track.mediaStreamTrack.id} track={track} />
      ))}
    </div>
  );
}