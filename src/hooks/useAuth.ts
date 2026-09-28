// This build has no account system: the user is always signed out. The shape
// stays so existing consumers keep compiling until their signed-in branches go.
type AuthUser = { id: string; name?: string | null; email?: string | null; image?: string | null };

const SIGNED_OUT = {
  isSignedIn: false,
  isGracePeriodOnly: false,
  isLoaded: true,
  session: null as { user: AuthUser } | null,
  user: null as AuthUser | null,
  refetch: async () => null,
};

export function useAuth() {
  return SIGNED_OUT;
}
