/*
 * SalonBook — email/password authentication regression test.
 *
 * Exercises the complete flow against a running API:
 *   register -> login (case-insensitive email) -> /auth/me -> logout
 *   + duplicate registration (409) and wrong password (401)
 *
 * A throwaway account is created and deleted again. Passwords, tokens and
 * password hashes are never printed.
 *
 * Usage:
 *   npm run test:auth
 *   AUTH_TEST_BASE_URL=http://localhost:5000/api npm run test:auth
 */

const path = require('node:path')
const crypto = require('node:crypto')
const mongoose = require('mongoose')

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { getTestMongoUri } = require('./lib/testDb.cjs')

const BASE_URL = (
  process.env.AUTH_TEST_BASE_URL || 'http://localhost:5000/api'
).replace(/\/$/, '')

function randomEmail() {
  return `auth-test-${crypto.randomBytes(6).toString('hex')}@example.com`
}

function randomPassword() {
  // Guaranteed to satisfy: >=8 chars, contains a letter and a digit.
  return `Aa1${crypto.randomBytes(8).toString('base64url')}`
}

let failures = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

async function request(method, route, { body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
}

async function deleteThrowawayUser(userId) {
  if (!userId) return
  const uri = getTestMongoUri()
  try {
    await mongoose.connect(uri)
    const result = await mongoose.connection.db
      .collection('users')
      .deleteOne({ _id: new mongoose.Types.ObjectId(userId) })
    console.log(
      result.deletedCount === 1
        ? 'INFO  throwaway account deleted'
        : 'WARN  throwaway account was already removed',
    )
  } catch (error) {
    console.log(`WARN  could not delete throwaway account (${error.name})`)
  } finally {
    await mongoose.disconnect().catch(() => {})
  }
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('This test requires Node.js 18 or newer (global fetch).')
    process.exit(1)
  }

  getTestMongoUri()

  const email = randomEmail()
  const password = randomPassword()
  let userId = null

  console.log(`Target API: ${BASE_URL}`)

  try {
    const register = await request('POST', '/auth/register', {
      body: { name: 'Auth Flow Test', email, password },
    })
    userId = register.json?.user?.id ?? null

    check('register returns 201', register.status === 201, `got ${register.status}`)
    check(
      'register returns a JWT',
      typeof register.json?.token === 'string' && register.json.token.length > 0,
    )
    check('register returns a customer user', register.json?.user?.role === 'customer')
    check('register stores a normalized email', register.json?.user?.email === email)

    const login = await request('POST', '/auth/login', {
      body: { email: email.toUpperCase(), password },
    })
    const token = login.json?.token

    check('login returns 200', login.status === 200, `got ${login.status}`)
    check('login accepts a case-different email', typeof token === 'string' && token.length > 0)

    const me = await request('GET', '/auth/me', { token })
    check('GET /auth/me returns 200', me.status === 200, `got ${me.status}`)
    check('GET /auth/me returns the same user', me.json?.user?.id === userId)

    const duplicate = await request('POST', '/auth/register', {
      body: { name: 'Auth Flow Test', email, password },
    })
    check('duplicate registration returns 409', duplicate.status === 409, `got ${duplicate.status}`)
    check(
      'duplicate registration explains that the account exists',
      typeof duplicate.json?.message === 'string' &&
        /already exists/i.test(duplicate.json.message),
    )

    const wrongPassword = await request('POST', '/auth/login', {
      body: { email, password: `${password}x` },
    })
    check('wrong password returns 401', wrongPassword.status === 401, `got ${wrongPassword.status}`)

    const logout = await request('POST', '/auth/logout', { token })
    check('logout returns 200', logout.status === 200, `got ${logout.status}`)
  } finally {
    await deleteThrowawayUser(userId)
  }

  console.log(
    failures === 0
      ? '\nAll authentication checks passed.'
      : `\n${failures} authentication check(s) failed.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('Auth test crashed:', error.name)
  process.exit(1)
})
