/*
 * SalonBook — end-to-end customer flow test.
 *
 * Verifies, against the running API and MongoDB:
 *   service catalogue, availability, booking, duplicate/overlap prevention,
 *   My Bookings, cross-user isolation, cancellation, profile update and
 *   avatar upload/removal.
 *
 * Creates two throwaway accounts and removes everything it created afterwards.
 * Passwords, tokens and hashes are never printed.
 *
 * Usage: npm run test:customer
 */

const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')
const mongoose = require('mongoose')

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { getTestMongoUri } = require('./lib/testDb.cjs')

const API_BASE = (
  process.env.TEST_API_BASE_URL || 'http://localhost:5000/api'
).replace(/\/$/, '')
const API_ORIGIN = new URL(API_BASE).origin
const UPLOAD_ROOT = path.resolve(__dirname, '..', 'uploads')

let failures = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

async function request(method, route, options = {}) {
  const headers = {}
  if (options.token) headers.Authorization = `Bearer ${options.token}`

  let body
  if (options.form) {
    body = options.form
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  const response = await fetch(`${API_BASE}${route}`, { method, headers, body })
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
}

function randomEmail(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}@example.com`
}

function randomPassword() {
  return `Aa1${crypto.randomBytes(8).toString('base64url')}`
}

function dateString(offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// A 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGQAAAAASUVORK5CYII=',
  'base64',
)

async function registerUser(prefix) {
  const email = randomEmail(prefix)
  const password = randomPassword()
  const response = await request('POST', '/auth/register', {
    body: { name: `Test ${prefix}`, email, password },
  })
  return {
    email,
    password,
    token: response.json?.token,
    user: response.json?.user,
    status: response.status,
  }
}

async function cleanup(state) {
  try {
    await mongoose.connect(getTestMongoUri())
    const db = mongoose.connection.db
    if (state.appointmentIds.length) {
      await db
        .collection('appointments')
        .deleteMany({ _id: { $in: state.appointmentIds.map((id) => new mongoose.Types.ObjectId(id)) } })
    }
    if (state.userIds.length) {
      await db.collection('appointments').deleteMany({
        customer: { $in: state.userIds.map((id) => new mongoose.Types.ObjectId(id)) },
      })
      await db.collection('users').deleteMany({
        _id: { $in: state.userIds.map((id) => new mongoose.Types.ObjectId(id)) },
      })
    }
    console.log('INFO  throwaway accounts and appointments removed')
  } catch (error) {
    console.log(`WARN  cleanup failed (${error.name})`)
  } finally {
    await mongoose.disconnect().catch(() => {})
  }

  for (const url of state.avatarUrls) {
    const file = path.join(UPLOAD_ROOT, url.replace('/uploads/', ''))
    if (!file.startsWith(path.join(UPLOAD_ROOT, 'avatars'))) continue
    try {
      fs.unlinkSync(file)
    } catch {
      // Already removed by the API.
    }
  }
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('This test requires Node.js 18 or newer (global fetch).')
    process.exit(1)
  }

  const state = { userIds: [], appointmentIds: [], avatarUrls: [] }
  const date = dateString(1)
  getTestMongoUri()

  try {
    console.log(`Target API: ${API_BASE}`)

    // 1. Catalogue
    const services = await request('GET', '/services')
    const catalogue = Array.isArray(services.json?.data) ? services.json.data : []
    check('service catalogue returns real database records', services.status === 200 && catalogue.length > 0, `count ${catalogue.length}`)
    const service = catalogue[0]
    if (!service) throw new Error('No services are seeded.')

    // 2. Availability
    const availability = await request(
      'GET',
      `/appointments/availability?serviceId=${service.id}&date=${date}`,
    )
    const slots = Array.isArray(availability.json?.availableSlots)
      ? availability.json.availableSlots
      : []
    check('availability returns real slots', availability.status === 200 && slots.length > 0)
    const slot = slots[0]
    if (!slot) throw new Error('No availability slots returned.')

    // 3. Unauthenticated booking is rejected
    const unauth = await request('POST', '/appointments', {
      body: { serviceId: service.id, date, time: slot },
    })
    check('unauthenticated booking is rejected', unauth.status === 401, `got ${unauth.status}`)
    const unauthDashboard = await request('GET', '/customers/me/dashboard')
    check('unauthenticated dashboard is rejected', unauthDashboard.status === 401)

    // 4. Register two customers
    const customerA = await registerUser('book-a')
    const customerB = await registerUser('book-b')
    if (customerA.user?.id) state.userIds.push(customerA.user.id)
    if (customerB.user?.id) state.userIds.push(customerB.user.id)
    check('customer A registered', customerA.status === 201 && typeof customerA.token === 'string')
    check('customer B registered', customerB.status === 201 && typeof customerB.token === 'string')

    // 5. Create a booking
    const created = await request('POST', '/appointments', {
      token: customerA.token,
      body: {
        serviceId: service.id,
        date,
        time: slot,
        phone: '+880 1700 000000',
        notes: 'Automated test booking',
      },
    })
    const appointment = created.json?.data
    check('appointment is created and pending', created.status === 201 && appointment?.status === 'pending')
    if (appointment?.id) state.appointmentIds.push(appointment.id)

    // 6. My Bookings + dashboard
    const mine = await request('GET', '/customers/me/appointments', { token: customerA.token })
    const myAppointments = Array.isArray(mine.json?.data) ? mine.json.data : []
    check('My Bookings contains the new appointment', mine.status === 200 && myAppointments.some((item) => item.id === appointment?.id))

    const dashboard = await request('GET', '/customers/me/dashboard', { token: customerA.token })
    check(
      'dashboard counts the upcoming appointment',
      dashboard.status === 200 && dashboard.json?.data?.stats?.upcoming >= 1,
    )

    // 7. Duplicate/overlapping booking prevention
    const duplicate = await request('POST', '/appointments', {
      token: customerA.token,
      body: { serviceId: service.id, date, time: slot },
    })
    check('same customer cannot book the same slot twice', duplicate.status === 409, `got ${duplicate.status}`)

    const conflictByOther = await request('POST', '/appointments', {
      token: customerB.token,
      body: { serviceId: service.id, date, time: slot },
    })
    check('another customer cannot take a booked slot', conflictByOther.status === 409, `got ${conflictByOther.status}`)

    // 8. Cross-user isolation
    const bAppointments = await request('GET', '/customers/me/appointments', { token: customerB.token })
    const bList = Array.isArray(bAppointments.json?.data) ? bAppointments.json.data : []
    check('customer B cannot see customer A appointments', bAppointments.status === 200 && !bList.some((item) => item.id === appointment?.id))

    if (appointment?.id) {
      const crossCancel = await request('PATCH', `/appointments/${appointment.id}/cancel`, {
        token: customerB.token,
      })
      check('customer B cannot cancel customer A appointment', crossCancel.status === 404, `got ${crossCancel.status}`)
    }

    // 9. Cancellation and slot release
    if (appointment?.id) {
      const cancelled = await request('PATCH', `/appointments/${appointment.id}/cancel`, {
        token: customerA.token,
      })
      check('customer A can cancel their own appointment', cancelled.status === 200 && cancelled.json?.data?.status === 'cancelled')
      state.appointmentIds = state.appointmentIds.filter((id) => id !== appointment.id)

      const afterCancel = await request(
        'GET',
        `/appointments/availability?serviceId=${service.id}&date=${date}`,
      )
      const afterSlots = Array.isArray(afterCancel.json?.availableSlots)
        ? afterCancel.json.availableSlots
        : []
      check('cancelled slot becomes available again', afterSlots.includes(slot))
    }

    // 10. Profile update
    const profileUpdate = await request('PATCH', '/customers/me', {
      token: customerA.token,
      body: { name: 'Updated Test Customer', email: customerA.email, phone: '+880 1700 111111' },
    })
    check(
      'profile update is saved',
      profileUpdate.status === 200 &&
        profileUpdate.json?.user?.name === 'Updated Test Customer' &&
        profileUpdate.json?.user?.phone === '+880 1700 111111',
    )

    // 11. Avatar upload, serving and removal
    const uploadForm = new FormData()
    uploadForm.append('avatar', new Blob([TINY_PNG], { type: 'image/png' }), 'avatar-test.png')
    const uploaded = await request('POST', '/customers/me/avatar', {
      token: customerA.token,
      form: uploadForm,
    })
    const avatarUrl = uploaded.json?.user?.avatarUrl
    check('avatar upload stores a URL', uploaded.status === 200 && typeof avatarUrl === 'string' && avatarUrl.startsWith('/uploads/avatars/'))
    if (avatarUrl) {
      state.avatarUrls.push(avatarUrl)
      const imageResponse = await fetch(`${API_ORIGIN}${avatarUrl}`)
      check('uploaded avatar is served', imageResponse.status === 200 && (imageResponse.headers.get('content-type') || '').startsWith('image/'))
    }

    const badForm = new FormData()
    badForm.append('avatar', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'notes.txt')
    const badUpload = await request('POST', '/customers/me/avatar', {
      token: customerA.token,
      form: badForm,
    })
    check('non-image uploads are rejected', badUpload.status === 400, `got ${badUpload.status}`)

    const removed = await request('DELETE', '/customers/me/avatar', { token: customerA.token })
    check('avatar removal clears the URL', removed.status === 200 && !removed.json?.user?.avatarUrl)
    if (avatarUrl) {
      const gone = await fetch(`${API_ORIGIN}${avatarUrl}`)
      check('removed avatar file is deleted', gone.status === 404, `got ${gone.status}`)
      state.avatarUrls = state.avatarUrls.filter((url) => url !== avatarUrl)
    }
  } finally {
    await cleanup(state)
  }

  console.log(
    failures === 0
      ? '\nAll customer-flow checks passed.'
      : `\n${failures} customer-flow check(s) failed.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('Customer-flow test crashed:', error.name, error.message)
  process.exit(1)
})
