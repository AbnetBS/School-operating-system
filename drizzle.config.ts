import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Generation is offline; the runtime driver is chosen in src/db/client.ts.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/sos',
  },
  verbose: true,
  strict: false,
} satisfies Config;
