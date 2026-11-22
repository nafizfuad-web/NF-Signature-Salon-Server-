export interface ServerConfig {
  port: number
  nodeEnv: string
  clientOrigin: string
  mongoUri: string
  jwtSecret: string
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

  let clientOrigin: string
  try {
    const parsedClientUrl = new URL(clientUrl)
    if (
      parsedClientUrl.origin !== clientUrl.replace(/\/$/, '') ||
      (nodeEnv === 'production' && parsedClientUrl.protocol !== 'https:')
    ) {
      throw new Error()
    }
    clientOrigin = parsedClientUrl.origin
  } catch {
    throw new Error('CLIENT_URL must be a valid frontend origin.')
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
  const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL?.trim()
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

  activeConfig = {
    port,
    nodeEnv,
    clientOrigin,
    mongoUri,
    jwtSecret,
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
