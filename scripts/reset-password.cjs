/*
 * SalonBook — safely reset an email/password account password.
 *
 * This is an operator/developer recovery tool for an account whose stored
 * password hash no longer matches the password the owner knows (for example an
 * account created during debugging with a different password). It does not
 * bypass authentication and does not reveal any existing credential.
 *
 * The new password is never accepted as a command-line argument and is never
 * printed. Supply it with the RESET_PASSWORD environment variable, pipe it on
 * stdin, or type it at the hidden prompt.
 *
 * Usage:
 *   npm run reset-password -- user@example.com
 *   RESET_PASSWORD='<new password>' npm run reset-password -- user@example.com
 *   echo '<new password>' | npm run reset-password -- user@example.com
 */

const path = require('node:path')
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })

const BCRYPT_ROUNDS = 12
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function maskEmail(email) {
  const [local, domain] = email.split('@')
  return `${String(local).slice(0, 2)}***@${domain || '?'}`
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) return 'A password is required.'
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be 72 bytes or fewer.'
  if (!/[A-Za-z]/.test(password)) return 'Password must include a letter.'
  if (!/\d/.test(password)) return 'Password must include a number.'
  return null
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const stdout = process.stdout
    if (!stdin.isTTY) {
      reject(new Error('No interactive terminal available; set RESET_PASSWORD instead.'))
      return
    }

    stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''
    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
    }
    const onData = (chunk) => {
      const character = String(chunk)
      if (character === '\u0003') {
        cleanup()
        process.exit(130)
      }
      if (character === '\r' || character === '\n' || character === '\u0004') {
        cleanup()
        resolve(value)
        return
      }
      if (character === '\u0008' || character === '\u007f') {
        value = value.slice(0, -1)
        return
      }
      value += character
    }

    stdin.on('data', onData)
  })
}

function readPipedPassword() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')))
    process.stdin.on('error', reject)
    process.stdin.resume()
  })
}

async function readPassword() {
  if (typeof process.env.RESET_PASSWORD === 'string' && process.env.RESET_PASSWORD.length > 0) {
    return process.env.RESET_PASSWORD
  }
  if (process.stdin.isTTY) {
    return promptHidden('New password (input hidden): ')
  }
  return readPipedPassword()
}

async function main() {
  const emailArgument = process.argv[2] || process.env.RESET_EMAIL
  if (!emailArgument || !EMAIL_PATTERN.test(String(emailArgument).trim())) {
    console.error(
      'Usage: npm run reset-password -- <email>\n' +
        'Provide the new password via RESET_PASSWORD, stdin, or the hidden prompt.',
    )
    process.exit(1)
  }

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not configured in the server .env file.')
    process.exit(1)
  }

  const email = String(emailArgument).trim().toLowerCase()
  const password = await readPassword()
  const validationError = validatePassword(password)
  if (validationError) {
    console.error(`Cannot set password: ${validationError}`)
    process.exit(1)
  }

  await mongoose.connect(process.env.MONGODB_URI)
  try {
    const users = mongoose.connection.db.collection('users')
    const user = await users.findOne({ email })
    if (!user) {
      console.error(`No account found for ${maskEmail(email)}. Register it first.`)
      process.exitCode = 1
      return
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const update = { passwordHash }
    if (user.email !== email) update.email = email

    await users.updateOne({ _id: user._id }, { $set: update })
    console.log(`Password updated for ${maskEmail(email)}. The password was not logged.`)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      console.error('That email is already used by another account.')
    } else {
      console.error('Password reset failed:', error instanceof Error ? error.name : 'UnknownError')
    }
    process.exitCode = 1
  } finally {
    await mongoose.disconnect().catch(() => {})
  }
}

main().catch((error) => {
  console.error('Password reset crashed:', error.name)
  process.exit(1)
})
