/*
 * SalonBook — test database guard.
 *
 * Database-backed test scripts must connect only to the dedicated test
 * database. This module never prints connection strings or credentials.
 */

const path = require('node:path')
const dotenv = require('dotenv')

dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true })
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.test'), quiet: true })

const TEST_DB_NAME = 'nf_signature_salon_test'

function databaseNameFromUri(uri) {
  try {
    const parsed = new URL(uri)
    const segments = parsed.pathname.split('/').filter(Boolean)
    return segments.length ? segments[segments.length - 1] : 'test'
  } catch {
    return null
  }
}

function getTestMongoUri() {
  const uri = process.env.TEST_MONGODB_URI?.trim()
  if (!uri) {
    throw new Error(
      'TEST_MONGODB_URI is required for database-backed tests. Create salonbook-server/.env.test from env.test.example.',
    )
  }

  const dbName = databaseNameFromUri(uri)
  if (dbName !== TEST_DB_NAME) {
    throw new Error(
      `Refusing to run database tests against "${dbName ?? 'unparseable'}". Expected "${TEST_DB_NAME}".`,
    )
  }

  return uri
}

module.exports = { getTestMongoUri, TEST_DB_NAME }
