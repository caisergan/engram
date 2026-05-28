import { headers } from "next/headers";
import { getServerAuthSession } from "@/server/auth";
import requestIp from "request-ip";

import { db } from "@karakeep/db";
import { Context, createCallerFactory } from "@karakeep/trpc";
import { authenticateApiKey } from "@karakeep/trpc/auth";
import { verifyVaultToken } from "@karakeep/trpc/lib/vaultCrypto";
import { appRouter } from "@karakeep/trpc/routers/_app";
import serverConfig from "@karakeep/shared/config";

function extractVaultKey(req: Request, userId: string): Buffer | null {
  const vaultToken = req.headers.get("x-vault-token");
  if (!vaultToken) return null;
  try {
    const result = verifyVaultToken(vaultToken, serverConfig.signingSecret());
    if (result.userId !== userId) return null;
    return result.encryptionKey;
  } catch {
    return null;
  }
}

export async function createContextFromRequest(req: Request) {
  // TODO: This is a hack until we offer a proper REST API instead of the trpc based one.
  // Check if the request has an Authorization token, if it does, assume that API key authentication is requested.
  const ip = requestIp.getClientIp({
    headers: Object.fromEntries(req.headers.entries()),
  });
  const authorizationHeader = req.headers.get("Authorization");
  if (authorizationHeader && authorizationHeader.startsWith("Bearer ")) {
    const token = authorizationHeader.split(" ")[1];
    try {
      const authResult = await authenticateApiKey(token, db);
      const vaultKey = extractVaultKey(req, authResult.user.id);
      return {
        user: authResult.user,
        auth: {
          type: "apiKey" as const,
          keyId: authResult.apiKey.keyId,
          scopes: authResult.apiKey.scopes,
        },
        db,
        req: {
          ip,
        },
        vaultKey,
      };
    } catch {
      // Fallthrough to cookie-based auth
    }
  }

  return createContext(db, ip, req);
}

export const createContext = async (
  database?: typeof db,
  ip?: string | null,
  req?: Request,
): Promise<Context> => {
  const session = await getServerAuthSession();
  if (ip === undefined) {
    const hdrs = await headers();
    ip = requestIp.getClientIp({
      headers: Object.fromEntries(hdrs.entries()),
    });
  }
  const userId = session?.user?.id;
  const vaultKey = req && userId ? extractVaultKey(req, userId) : null;
  return {
    user: session?.user ?? null,
    auth: session?.user
      ? {
          type: "session" as const,
        }
      : null,
    db: database ?? db,
    req: {
      ip,
    },
    vaultKey,
  };
};

const createCaller = createCallerFactory(appRouter);

export const api = createCaller(createContext);

export const createTrcpClientFromCtx = createCaller;
