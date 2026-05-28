let vaultToken: string | null = null;

export function setVaultToken(token: string | null) {
  vaultToken = token;
}

export function getVaultToken(): string | null {
  return vaultToken;
}
