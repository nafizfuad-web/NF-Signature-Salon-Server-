export interface EmailConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from: string
  replyTo?: string
  adminRecipient?: string
}

export interface StripeConfig {
  secretKey: string
  mode: 'TEST' | 'LIVE'
  webhookSecret?: string
  successUrl: string
  cancelUrl: string
}

export interface MobileWalletConfig {
  baseUrl: string
  appKey: string
  appSecret: string
  username: string
  password: string
  callbackUrl: string
}

export interface NagadConfig {
  baseUrl: string
  merchantId: string
  accountNumber: string
  merchantPrivateKey: string
  gatewayPublicKey: string
  serverIp: string
  callbackUrl: string
  signatureAlgorithm: 'SHA1' | 'SHA256'
}

export interface ServerConfig {
  port: number
  nodeEnv: string
  clientOrigin: string
  mongoUri: string
  jwtSecret: string
  auth: {
    emailVerificationRequired: boolean
    passwordResetTtlMinutes: number
    verificationTtlMinutes: number
  }
  email?: EmailConfig
  stripe?: StripeConfig
  bkash?: MobileWalletConfig
  nagad?: NagadConfig
  googleOAuth?: {
    clientId: string
    clientSecret: string
    callbackUrl: string
  }
}

let activeConfig: ServerConfig | undefined

function requiredValue(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required.`)
  }
  return value
}

function optionalValue(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

function parseOrigin(name: string, value: string, nodeEnv: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL.`)
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be a frontend origin without a path.`)
  }
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS in production.`)
  }
  return parsed.origin
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = optionalValue(name)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 525600) {
    throw new Error(`${name} must be a positive integer number of minutes.`)
  }
  return value
}

function parsePaymentReturnUrl(
  name: string,
  fallback: string,
  clientOrigin: string,
  nodeEnv: string,
): string {
  const raw = optionalValue(name) ?? fallback
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${name} must be a valid URL.`)
  }
  if (parsed.origin !== clientOrigin) {
    throw new Error(`${name} must use the configured CLIENT_URL origin.`)
  }
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS in production.`)
  }
  return parsed.toString()
}

function loadEmailConfig(): EmailConfig | undefined {
  const host = optionalValue('SMTP_HOST')
  const from = optionalValue('EMAIL_FROM')
  const anyEmailSetting = Boolean(
    host ||
      from ||
      optionalValue('SMTP_USER') ||
      optionalValue('SMTP_PASS') ||
      optionalValue('EMAIL_ADMIN_TO'),
  )

  if (!anyEmailSetting) return undefined
  if (!host || !from) {
    throw new Error(
      'SMTP_HOST and EMAIL_FROM are required when email delivery is configured.',
    )
  }

  const parsedPort = Number(optionalValue('SMTP_PORT') ?? '587')
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535.')
  }

  const user = optionalValue('SMTP_USER')
  const pass = optionalValue('SMTP_PASS')
  if ((user && !pass) || (!user && pass)) {
    throw new Error('SMTP_USER and SMTP_PASS must be configured together.')
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    throw new Error('EMAIL_FROM must be a valid email address.')
  }

  const replyTo = optionalValue('EMAIL_REPLY_TO')
  const adminRecipient = optionalValue('EMAIL_ADMIN_TO')
  if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
    throw new Error('EMAIL_REPLY_TO must be a valid email address.')
  }
  if (adminRecipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminRecipient)) {
    throw new Error('EMAIL_ADMIN_TO must be a valid email address.')
  }

  return {
    host,
    port: parsedPort,
    secure:
      optionalValue('SMTP_SECURE')?.toLowerCase() === 'true' ||
      parsedPort === 465,
    ...(user && pass ? { user, pass } : {}),
    from,
    ...(replyTo ? { replyTo } : {}),
    ...(adminRecipient ? { adminRecipient } : {}),
  }
}

function loadStripeConfig(
  clientOrigin: string,
  nodeEnv: string,
): StripeConfig | undefined {
  const secretKey = optionalValue('STRIPE_SECRET_KEY')
  if (!secretKey) return undefined

  if (!/^sk_(test|live)_/.test(secretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe test or live secret key.')
  }

  const mode = secretKey.startsWith('sk_live_') ? 'LIVE' : 'TEST'
  if (
    mode === 'LIVE' &&
    (nodeEnv !== 'production' ||
      optionalValue('PAYMENT_ALLOW_LIVE_PAYMENTS')?.toLowerCase() !== 'true')
  ) {
    // Never enable live charges by accident. The server keeps running with
    // Stripe disabled so an owner can deliberately opt in.
    return undefined
  }

  const paymentEnv = optionalValue('PAYMENT_ENV')?.toUpperCase() ?? 'TEST'
  if (mode === 'TEST' && paymentEnv !== 'TEST') {
    return undefined
  }

  const webhookSecret = optionalValue('STRIPE_WEBHOOK_SECRET')
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret.')
  }

  return {
    secretKey,
    mode,
    ...(webhookSecret ? { webhookSecret } : {}),
    successUrl: parsePaymentReturnUrl(
      'STRIPE_CHECKOUT_SUCCESS_URL',
      `${clientOrigin}/payment/success`,
      clientOrigin,
      nodeEnv,
    ),
    cancelUrl: parsePaymentReturnUrl(
      'STRIPE_CHECKOUT_CANCEL_URL',
      `${clientOrigin}/payment/cancel`,
      clientOrigin,
      nodeEnv,
    ),
  }
}

function loadMobileWalletConfig(
  prefix: 'BKASH',
  nodeEnv: string,
): MobileWalletConfig | undefined {
  const names = {
    baseUrl: `${prefix}_BASE_URL`,
    appKey: `${prefix}_APP_KEY`,
    appSecret: `${prefix}_APP_SECRET`,
    username: `${prefix}_USERNAME`,
    password: `${prefix}_PASSWORD`,
    callbackUrl: `${prefix}_CALLBACK_URL`,
  } as const

  const values = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, optionalValue(name)]),
  ) as Record<keyof typeof names, string | undefined>

  const configured = Object.values(values).filter(Boolean).length
  if (configured === 0) return undefined
  if (configured !== Object.keys(names).length) {
    throw new Error(
      `${prefix} payment configuration is incomplete. All ${prefix}_* variables are required together.`,
    )
  }

  let baseUrl: URL
  let callbackUrl: URL
  try {
    baseUrl = new URL(values.baseUrl!)
    callbackUrl = new URL(values.callbackUrl!)
  } catch {
    throw new Error(`${prefix} payment URLs must be valid URLs.`)
  }
  if (nodeEnv === 'production' && (baseUrl.protocol !== 'https:' || callbackUrl.protocol !== 'https:')) {
    throw new Error(`${prefix} payment URLs must use HTTPS in production.`)
  }
  if (!baseUrl.hostname.includes('sandbox')) {
    throw new Error(`${prefix}_BASE_URL must point to the provider sandbox environment.`)
  }

  return {
    baseUrl: baseUrl.toString(),
    appKey: values.appKey!,
    appSecret: values.appSecret!,
    username: values.username!,
    password: values.password!,
    callbackUrl: callbackUrl.toString(),
  }
}

function loadNagadConfig(nodeEnv: string): NagadConfig | undefined {
  const names = {
    baseUrl: 'NAGAD_BASE_URL',
    merchantId: 'NAGAD_MERCHANT_ID',
    accountNumber: 'NAGAD_ACCOUNT_NUMBER',
    merchantPrivateKey: 'NAGAD_MERCHANT_PRIVATE_KEY',
    gatewayPublicKey: 'NAGAD_GATEWAY_PUBLIC_KEY',
    serverIp: 'NAGAD_SERVER_IP',
    callbackUrl: 'NAGAD_CALLBACK_URL',
  } as const

  const values = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, optionalValue(name)]),
  ) as Record<keyof typeof names, string | undefined>

  const configured = Object.values(values).filter(Boolean).length
  if (configured === 0) return undefined
  if (configured !== Object.keys(names).length) {
    throw new Error(
      'NAGAD payment configuration is incomplete. All required NAGAD_* variables must be configured together.',
    )
  }

  let baseUrl: URL
  let callbackUrl: URL
  try {
    baseUrl = new URL(values.baseUrl!)
    callbackUrl = new URL(values.callbackUrl!)
  } catch {
    throw new Error('NAGAD_BASE_URL and NAGAD_CALLBACK_URL must be valid URLs.')
  }
  if (nodeEnv === 'production' && (baseUrl.protocol !== 'https:' || callbackUrl.protocol !== 'https:')) {
    throw new Error('NAGAD payment URLs must use HTTPS in production.')
  }
  if (!baseUrl.hostname.includes('sandbox')) {
    throw new Error('NAGAD_BASE_URL must point to the provider sandbox environment.')
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(values.serverIp!)) {
    throw new Error('NAGAD_SERVER_IP must be an IPv4 address.')
  }

  const signatureAlgorithm = (optionalValue('NAGAD_SIGNATURE_ALGORITHM') ?? 'SHA256').toUpperCase()
  if (signatureAlgorithm !== 'SHA1' && signatureAlgorithm !== 'SHA256') {
    throw new Error('NAGAD_SIGNATURE_ALGORITHM must be SHA1 or SHA256.')
  }

  return {
    baseUrl: baseUrl.toString(),
    merchantId: values.merchantId!,
    accountNumber: values.accountNumber!,
    merchantPrivateKey: values.merchantPrivateKey!,
    gatewayPublicKey: values.gatewayPublicKey!,
    serverIp: values.serverIp!,
    callbackUrl: callbackUrl.toString(),
    signatureAlgorithm: signatureAlgorithm as NagadConfig['signatureAlgorithm'],
  }
}

export function loadServerConfig(): ServerConfig {
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development'
  const mongoUri = requiredValue('MONGODB_URI')
  const jwtSecret = requiredValue('JWT_SECRET')
  const clientUrl = requiredValue('CLIENT_URL')
  const portValue = process.env.PORT?.trim()
  const port = portValue ? Number(portValue) : 5000

  if (!/^mongodb(?:\+srv)?:\/\//i.test(mongoUri)) {
    throw new Error('MONGODB_URI must be a MongoDB connection URI.')
  }
  if (Buffer.byteLength(jwtSecret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes.')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.')
  }

  const clientOrigin = parseOrigin('CLIENT_URL', clientUrl, nodeEnv)

  const googleClientId = optionalValue('GOOGLE_CLIENT_ID')
  const googleClientSecret = optionalValue('GOOGLE_CLIENT_SECRET')
  const googleCallbackUrl = optionalValue('GOOGLE_CALLBACK_URL')
  const hasGoogleConfig = Boolean(
    googleClientId && googleClientSecret && googleCallbackUrl,
  )

  let googleOAuth: ServerConfig['googleOAuth']
  if (hasGoogleConfig) {
    let callbackUrl: URL
    try {
      callbackUrl = new URL(googleCallbackUrl!)
    } catch {
      throw new Error('GOOGLE_CALLBACK_URL must be a valid URL.')
    }
    if (
      callbackUrl.pathname !== '/api/auth/google/callback' ||
      (nodeEnv === 'production' && callbackUrl.protocol !== 'https:')
    ) {
      throw new Error(
        'GOOGLE_CALLBACK_URL must use the /api/auth/google/callback path and HTTPS in production.',
      )
    }

    googleOAuth = {
      clientId: googleClientId!,
      clientSecret: googleClientSecret!,
      callbackUrl: callbackUrl.toString(),
    }
  }

  const email = loadEmailConfig()
  const stripe = loadStripeConfig(clientOrigin, nodeEnv)
  const bkash = loadMobileWalletConfig('BKASH', nodeEnv)
  const nagad = loadNagadConfig(nodeEnv)

  const emailVerificationRequired =
    optionalValue('EMAIL_VERIFICATION_REQUIRED')?.toLowerCase() === 'true'
  if (emailVerificationRequired && !email) {
    throw new Error(
      'EMAIL_VERIFICATION_REQUIRED=true requires SMTP_HOST and EMAIL_FROM to be configured.',
    )
  }

  activeConfig = {
    port,
    nodeEnv,
    clientOrigin,
    mongoUri,
    jwtSecret,
    auth: {
      emailVerificationRequired,
      passwordResetTtlMinutes: readPositiveInteger(
        'PASSWORD_RESET_TTL_MINUTES',
        60,
      ),
      verificationTtlMinutes: readPositiveInteger(
        'EMAIL_VERIFICATION_TTL_MINUTES',
        1440,
      ),
    },
    ...(email ? { email } : {}),
    ...(stripe ? { stripe } : {}),
    ...(bkash ? { bkash } : {}),
    ...(nagad ? { nagad } : {}),
    ...(googleOAuth ? { googleOAuth } : {}),
  }
  return activeConfig
}

export function getServerConfig(): ServerConfig {
  if (!activeConfig) {
    return loadServerConfig()
  }
  return activeConfig
}
