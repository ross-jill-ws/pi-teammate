import { Database } from 'bun:sqlite'
import { initSchema } from '../schema.ts'

export function makeDb(): Database {
  const db = new Database(':memory:', { strict: true })
  initSchema(db)
  return db
}
