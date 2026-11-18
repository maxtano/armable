import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { ToolError, type Account } from './services';
import { newId, type Store } from './store';

/**
 * Sign-in for people and for assistants. Kept simple on purpose: email and password for people, standard OAuth
 * with PKCE for assistants. Passwords are stored as scrypt hashes; tokens are stored as SHA-256 hashes, never raw.
 */
const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
const sha = (value: string) => createHash('sha256').update(value).digest('base64url');
const secret = () => randomBytes(32).toString('base64url');
export const SCOPES = ['observe', 'design', 'propose'] as const;
const SESSION_DAYS = 30, ACCESS_SECONDS = 3600, REFRESH_DAYS = 60, CODE_SECONDS = 300;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${(await scrypt(password, salt, 64)).toString('base64url')}`;
}
export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

interface SessionRow { account: string; expiresAt: number }
interface TokenRow { kind: 'access' | 'refresh'; account: string; clientId: string; clientName: string; scopes: string[]; expiresAt: number; resource?: string; grant: string }
interface CodeRow { account: string; clientId: string; challenge: string; redirectUri: string; scopes: string[]; resource?: string; expiresAt: number }
export interface PendingAuthorization { client: { id: string; name: string }; account: string; params: { state?: string; scopes: string[]; codeChallenge: string; redirectUri: string; resource?: string }; expiresAt: number }

export class Auth {
  constructor(private store: Store, private now: () => number = Date.now) {}

  // ---- People ----------------------------------------------------------------------------------------------------

  async signUp(email: string, password: string): Promise<Account> {
    email = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new ToolError('invalid', 'Enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new ToolError('invalid', 'Use a password of at least 8 characters.');
    if (await this.store.lookup('accounts', email)) throw new ToolError('exists', 'An account with that email already exists. Sign in instead.');
    const account: Account = { id: `acct_${newId(9)}`, email, passwordHash: await hashPassword(password), createdAt: this.now(), assistantMode: 'observe' };
    await this.store.put('accounts', '', account.id, account, { expectedRev: 0, lookup: email });
    return account;
  }
  /** A bench without sign-up: everything works, nothing is asked. Saved later with an email or Google. */
  async guest(): Promise<Account> {
    const account: Account = { id: `acct_${newId(9)}`, email: '', passwordHash: '', createdAt: this.now(), assistantMode: 'observe', guest: true, lastSeen: this.now() };
    await this.store.put('accounts', '', account.id, account, { expectedRev: 0 });
    return account;
  }
  /** Turn a guest bench into a normal account, keeping everything on it. */
  async save(accountId: string, email: string, password: string): Promise<Account> {
    email = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new ToolError('invalid', 'Enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new ToolError('invalid', 'Use a password of at least 8 characters.');
    const row = await this.store.get<Account>('accounts', '', accountId);
    if (!row?.data.guest) throw new ToolError('invalid', 'This bench is already saved.');
    if (await this.store.lookup('accounts', email)) throw new ToolError('exists', 'An account with that email already exists. Sign in instead; this guest bench stays on this browser until then.');
    const account: Account = { ...row.data, email, passwordHash: await hashPassword(password), guest: undefined };
    await this.store.put('accounts', '', account.id, account, { expectedRev: row.rev, lookup: email });
    return account;
  }
  /**
   * Google sign-in, with an email Google has verified. Signs in to the account with that email if there is one;
   * otherwise saves the current guest bench under it, or makes a new account.
   */
  async google(profile: { sub: string; email: string }, current?: string): Promise<Account> {
    const email = profile.email.trim().toLowerCase();
    const existing = await this.store.lookup<Account>('accounts', email);
    if (existing) {
      if (existing.data.google !== profile.sub) {
        // Sign-up never proved who owns this email; Google just did. Whoever set a password on it before, and
        // anything they signed in or connected, loses access. The owner signs in with Google from now on.
        const proven: Account = { ...existing.data, google: profile.sub, passwordHash: '' };
        await this.store.put('accounts', '', existing.id, proven, { expectedRev: existing.rev, lookup: email });
        await this.endAllSessions(existing.id);
        for (const r of await this.store.list<TokenRow>('oauth_tokens', '', 100_000)) if (r.data.account === existing.id) await this.store.delete('oauth_tokens', '', r.id);
        return proven;
      }
      return existing.data;
    }
    const guest = current ? await this.store.get<Account>('accounts', '', current) : undefined;
    if (guest?.data.guest) {
      const account: Account = { ...guest.data, email, google: profile.sub, guest: undefined };
      await this.store.put('accounts', '', account.id, account, { expectedRev: guest.rev, lookup: email });
      return account;
    }
    const account: Account = { id: `acct_${newId(9)}`, email, passwordHash: '', createdAt: this.now(), assistantMode: 'observe', google: profile.sub };
    await this.store.put('accounts', '', account.id, account, { expectedRev: 0, lookup: email });
    return account;
  }
  /** Note that a guest is still using their bench, at most every few hours. */
  async seen(account: Account) {
    if (!account.guest || (account.lastSeen ?? 0) > this.now() - 6 * 3600_000) return;
    const row = await this.store.get<Account>('accounts', '', account.id);
    if (row) await this.store.put('accounts', '', account.id, { ...row.data, lastSeen: this.now() }, { expectedRev: row.rev }).catch(() => {});
  }
  /** Delete guest benches nobody has opened for this many days. Returns how many went. */
  async purgeGuests(days = 30): Promise<string[]> {
    const cutoff = this.now() - days * 86400_000, gone: string[] = [];
    for (const row of await this.store.list<Account>('accounts', '', 100_000)) {
      if (row.data.guest && (row.data.lastSeen ?? row.data.createdAt) < cutoff) { await this.deleteAccount(row.id); gone.push(row.id); }
    }
    return gone;
  }
  async signIn(email: string, password: string): Promise<Account> {
    const row = await this.store.lookup<Account>('accounts', email.trim().toLowerCase());
    // Hash even when the account is missing, so timing does not reveal which emails exist.
    const ok = await checkPassword(password, row?.data.passwordHash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    if (!row || !ok || !row.data.passwordHash) throw new ToolError('invalid', 'That email and password do not match.', 'If you signed up with Google, use Continue with Google.');
    return row.data;
  }
  async startSession(account: string): Promise<string> {
    const token = secret();
    await this.store.put<SessionRow>('sessions', '', sha(token), { account, expiresAt: this.now() + SESSION_DAYS * 86400_000 });
    return token;
  }
  async session(token: string | undefined): Promise<string | undefined> {
    if (!token) return undefined;
    const row = await this.store.get<SessionRow>('sessions', '', sha(token));
    if (!row || row.data.expiresAt < this.now()) return undefined;
    return row.data.account;
  }
  async endAllSessions(account: string) {
    for (const r of await this.store.list<SessionRow>('sessions', '', 100_000)) if (r.data.account === account) await this.store.delete('sessions', '', r.id);
  }
  async endSession(token: string | undefined) { if (token) await this.store.delete('sessions', '', sha(token)); }
  async deleteAccount(account: string) { await this.store.delete('accounts', '', account); await this.store.deleteAccount(account); }

  // ---- Assistants ------------------------------------------------------------------------------------------------

  /** Step one: the assistant app sent the person here. Park the request until they sign in and agree. */
  /** The name an assistant app registered with, for “Let Claude use Armable?” before the person has signed in. */
  async clientName(clientId: string): Promise<string | undefined> {
    const row = await this.store.get<OAuthClientInformationFull>('oauth_clients', '', clientId);
    return row ? clientName(row.data) : undefined;
  }
  async park(client: OAuthClientInformationFull, account: string, params: AuthorizationParams): Promise<string> {
    const id = newId(12);
    const scopes = (params.scopes?.length ? params.scopes : [...SCOPES]).filter(s => (SCOPES as readonly string[]).includes(s));
    await this.store.put<PendingAuthorization>('oauth_pending', '', id, {
      client: { id: client.client_id, name: clientName(client) }, account, expiresAt: this.now() + 600_000,
      params: { state: params.state, scopes: scopes.length ? scopes : [...SCOPES], codeChallenge: params.codeChallenge, redirectUri: params.redirectUri, resource: params.resource?.href },
    });
    return id;
  }
  async pending(id: string, account: string): Promise<PendingAuthorization> {
    const row = await this.store.get<PendingAuthorization>('oauth_pending', '', id);
    if (!row || row.data.expiresAt < this.now() || row.data.account !== account) throw new ToolError('not_found', 'This connection request has expired. Start again from your assistant.');
    return row.data;
  }
  /** Step two: the signed-in person agreed or declined. Returns where to send the browser. */
  async decide(id: string, account: string, allow: boolean): Promise<string> {
    const pending = await this.pending(id, account);
    await this.store.delete('oauth_pending', '', id);
    const url = new URL(pending.params.redirectUri);
    if (pending.params.state) url.searchParams.set('state', pending.params.state);
    if (!allow) { url.searchParams.set('error', 'access_denied'); return url.href; }
    const code = secret();
    await this.store.put<CodeRow>('oauth_codes', '', sha(code), { account, clientId: pending.client.id, challenge: pending.params.codeChallenge, redirectUri: pending.params.redirectUri, scopes: pending.params.scopes, resource: pending.params.resource, expiresAt: this.now() + CODE_SECONDS * 1000 });
    url.searchParams.set('code', code);
    return url.href;
  }
  async challenge(clientId: string, code: string): Promise<string> {
    const row = await this.store.get<CodeRow>('oauth_codes', '', sha(code));
    if (!row || row.data.clientId !== clientId || row.data.expiresAt < this.now()) throw new InvalidGrantError('Invalid or expired authorization code.');
    return row.data.challenge;
  }
  private async issue(base: Omit<TokenRow, 'kind' | 'expiresAt'>): Promise<OAuthTokens> {
    const access = secret(), refresh = secret();
    await this.store.put<TokenRow>('oauth_tokens', '', sha(access), { ...base, kind: 'access', expiresAt: this.now() + ACCESS_SECONDS * 1000 });
    await this.store.put<TokenRow>('oauth_tokens', '', sha(refresh), { ...base, kind: 'refresh', expiresAt: this.now() + REFRESH_DAYS * 86400_000 });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: base.scopes.join(' ') };
  }
  async exchangeCode(client: OAuthClientInformationFull, code: string, redirectUri?: string): Promise<OAuthTokens> {
    const row = await this.store.get<CodeRow>('oauth_codes', '', sha(code));
    if (!row || row.data.clientId !== client.client_id || row.data.expiresAt < this.now()) throw new InvalidGrantError('Invalid or expired authorization code.');
    await this.store.delete('oauth_codes', '', sha(code)); // Single use.
    if (redirectUri && redirectUri !== row.data.redirectUri) throw new InvalidGrantError('Redirect address does not match.');
    return this.issue({ account: row.data.account, clientId: client.client_id, clientName: clientName(client), scopes: row.data.scopes, resource: row.data.resource, grant: newId(9) });
  }
  async exchangeRefresh(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const row = await this.store.get<TokenRow>('oauth_tokens', '', sha(refreshToken));
    if (!row || row.data.kind !== 'refresh' || row.data.clientId !== client.client_id || row.data.expiresAt < this.now()) throw new InvalidGrantError('Invalid or expired refresh token.');
    await this.store.delete('oauth_tokens', '', sha(refreshToken)); // Rotated on every use.
    const narrowed = scopes?.length ? row.data.scopes.filter(s => scopes.includes(s)) : row.data.scopes;
    const { kind: _kind, expiresAt: _expiresAt, ...base } = row.data;
    return this.issue({ ...base, scopes: narrowed });
  }
  async verify(token: string): Promise<AuthInfo> {
    const row = await this.store.get<TokenRow>('oauth_tokens', '', sha(token));
    if (!row || row.data.kind !== 'access' || row.data.expiresAt < this.now()) throw new InvalidTokenError('Invalid or expired access token.');
    return { token, clientId: row.data.clientId, scopes: row.data.scopes, expiresAt: Math.floor(row.data.expiresAt / 1000), resource: row.data.resource ? new URL(row.data.resource) : undefined, extra: { account: row.data.account, clientName: row.data.clientName } };
  }
  async revoke(token: string, clientId?: string) {
    const row = await this.store.get<TokenRow>('oauth_tokens', '', sha(token));
    if (row && (!clientId || row.data.clientId === clientId)) await this.store.delete('oauth_tokens', '', sha(token));
  }
  /** Assistants this account has connected. */
  async grants(account: string): Promise<{ clientId: string; name: string; scopes: string[] }[]> {
    const rows = (await this.store.list<TokenRow>('oauth_tokens', '', 5000)).filter(r => r.data.account === account && r.data.kind === 'refresh' && r.data.expiresAt > this.now());
    const byClient = new Map<string, { clientId: string; name: string; scopes: string[] }>();
    for (const r of rows) byClient.set(r.data.clientId, { clientId: r.data.clientId, name: r.data.clientName, scopes: r.data.scopes });
    return [...byClient.values()];
  }
  /** Disconnect an assistant for good: every token it holds for this account stops working at once. */
  async disconnect(account: string, clientId: string) {
    for (const r of await this.store.list<TokenRow>('oauth_tokens', '', 5000)) if (r.data.account === account && r.data.clientId === clientId) await this.store.delete('oauth_tokens', '', r.id);
  }
}
const clientName = (client: OAuthClientInformationFull) => (client.client_name ?? 'Assistant').replace(/[^\w .\-()]/g, '').slice(0, 40) || 'Assistant';

/** Adapter to the MCP SDK's OAuth router. */
export class OAuthProvider implements OAuthServerProvider {
  constructor(private auth: Auth, private store: Store, private sessionOf: (res: Response) => Promise<string | undefined>, private publicUrl: string) {}
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async id => (await this.store.get<OAuthClientInformationFull>('oauth_clients', '', id))?.data,
      registerClient: async client => {
        const full = { ...client, client_id: (client as OAuthClientInformationFull).client_id ?? newId(16), client_id_issued_at: (client as OAuthClientInformationFull).client_id_issued_at ?? Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
        await this.store.put('oauth_clients', '', full.client_id, full);
        return full;
      },
    };
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const account = await this.sessionOf(res);
    if (!account) {
      // Not signed in: send them to sign in, then straight back to this same request.
      const back = new URL(res.req.originalUrl, this.publicUrl);
      res.redirect(`/?next=${encodeURIComponent(back.pathname + back.search)}`);
      return;
    }
    res.redirect(`/?consent=${await this.auth.park(client, account, params)}`);
  }
  challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) { return this.auth.challenge(client.client_id, code); }
  exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string) { return this.auth.exchangeCode(client, code, redirectUri); }
  exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]) { return this.auth.exchangeRefresh(client, refreshToken, scopes); }
  verifyAccessToken(token: string) { return this.auth.verify(token); }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) { await this.auth.revoke(request.token, client.client_id); }
}
