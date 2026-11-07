import { defineConfig } from 'drizzle-kit'

// Generates SQL migrations from server/db/schema.ts. The runtime applies them
// itself on startup (see server/db/migrate.ts); drizzle-kit never touches the live DB.
export default defineConfig({
  dialect: 'sqlite',
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
})
