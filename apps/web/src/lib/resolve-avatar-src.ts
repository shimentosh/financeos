/** Avatars are absolute URLs or data URIs; nothing to rewrite. */
export function resolveAvatarSrc(src: string) {
  return src;
}

export default resolveAvatarSrc;
