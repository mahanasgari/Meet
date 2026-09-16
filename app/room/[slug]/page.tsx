import { notFound } from "next/navigation";
import { RoomClient } from "@/components/RoomClient";
import { isValidRoomId } from "@/lib/room";

export default async function RoomPage({ params }: PageProps<"/room/[slug]">) {
  const { slug } = await params;

  if (!isValidRoomId(slug)) {
    notFound();
  }

  return <RoomClient roomName={slug} />;
}
