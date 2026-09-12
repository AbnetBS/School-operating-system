/**
 * SMS provider abstraction.
 *
 * THIS MODULE SENDS NOTHING. It defines the seam an Ethiopian SMS provider
 * plugs into later, and it is scrupulously honest about the fact that no
 * provider is connected today.
 *
 * The temptation in a demo system is a "mock provider" that marks messages as
 * sent so the screens look finished. That is a lie with real consequences: a
 * school would believe absence alerts reached parents when nothing left the
 * building. So there is no mock. When no provider is registered, messages are
 * stored with status `unconfigured` and the UI says exactly that.
 *
 * Adding a real provider is:
 *
 *   registerSmsProvider({
 *     key: 'geezsms',
 *     label: 'GeezSMS',
 *     async send(message, config) { ... return { ok: true, ref } },
 *   });
 *
 * No calling code changes.
 */

export type SmsSendRequest = {
  to: string;
  body: string;
};

export type SmsSendResult =
  | { ok: true; providerRef: string }
  | { ok: false; error: string };

export type SmsProviderConfig = {
  provider: string;
  senderId?: string;
  /**
   * A *reference* to a credential (an environment variable name or secret
   * key), never the credential itself. Secrets do not belong in the database.
   */
  apiKeyRef?: string;
  endpoint?: string;
  isEnabled: boolean;
};

export type SmsProvider = {
  /** Stable key, matching the value stored in the school's SMS settings. */
  key: string;
  /** Human name for the settings screen. */
  label: string;
  send(request: SmsSendRequest, config: SmsProviderConfig): Promise<SmsSendResult>;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const globalForSms = globalThis as unknown as {
  __sosSmsProviders?: Map<string, SmsProvider>;
};
const providers: Map<string, SmsProvider> = (globalForSms.__sosSmsProviders ??= new Map());

export function registerSmsProvider(provider: SmsProvider): void {
  providers.set(provider.key, provider);
}

export function getSmsProvider(key: string | null | undefined): SmsProvider | null {
  if (!key || key === 'none') return null;
  return providers.get(key) ?? null;
}

export function listSmsProviders(): { key: string; label: string }[] {
  return [...providers.values()].map((p) => ({ key: p.key, label: p.label }));
}

/** Test seam. Not used in application code. */
export function clearSmsProviders(): void {
  providers.clear();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type SmsAvailability =
  | { available: true; provider: SmsProvider; config: SmsProviderConfig }
  | { available: false; reason: 'no-provider' | 'disabled' | 'not-implemented'; detail: string };

/**
 * Can this school actually send an SMS right now?
 *
 * Every caller must handle the negative case explicitly. The three reasons are
 * distinguished because they need different fixes: nobody has chosen a
 * provider, a provider is chosen but switched off, or a provider is named in
 * settings but no implementation has been registered for it.
 */
export function resolveSmsAvailability(config: SmsProviderConfig | null): SmsAvailability {
  if (!config || config.provider === 'none') {
    return {
      available: false,
      reason: 'no-provider',
      detail: 'No SMS provider has been configured for this school.',
    };
  }
  if (!config.isEnabled) {
    return {
      available: false,
      reason: 'disabled',
      detail: 'SMS sending is switched off in the school settings.',
    };
  }
  const provider = getSmsProvider(config.provider);
  if (!provider) {
    return {
      available: false,
      reason: 'not-implemented',
      detail: `No integration is installed for "${config.provider}" yet, so nothing was sent.`,
    };
  }
  return { available: true, provider, config };
}
