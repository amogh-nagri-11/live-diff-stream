interface Props {
  username: string;
  avatarUrl?: string | null;
  size?: number;
  /** Show a green ring/dot when the user is currently connected. */
  online?: boolean;
  title?: string;
}

/** Derive a stable accent colour from a name. */
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** A round avatar: the user's image when present, otherwise their initial. */
export function Avatar({ username, avatarUrl, size = 26, online, title }: Props) {
  const initial = (username[0] ?? "?").toUpperCase();
  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.45),
    background: avatarUrl ? undefined : `hsl(${hueFor(username)} 55% 45%)`,
  };
  return (
    <span
      className={`avatar${online ? " online" : ""}`}
      style={style}
      title={title ?? username}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={username} />
      ) : (
        <span className="avatar-initial">{initial}</span>
      )}
    </span>
  );
}
