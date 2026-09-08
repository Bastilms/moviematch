import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { getVersion, LINK_TYPE, ROOT_PATH } from './config.js'
import * as log from './util/logger.js'

const translations: Map<string, Record<string, string>> = new Map()

async function getTranslationPaths(): Promise<string[]> {
  const i18nDir = join(fileURLToPath(import.meta.url), '..', '..', 'i18n')
  const translationPaths: string[] = []
  try {
    const entries = await readdir(i18nDir)
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        translationPaths.push(join(i18nDir, entry))
      }
    }
  } catch (err) {
    log.error('Failed to read i18n directory:', err)
  }
  return translationPaths
}

async function populateTranslations(): Promise<void> {
  const translationPaths = await getTranslationPaths()
  for (const translationPath of translationPaths) {
    try {
      const translation = JSON.parse(
        await readFile(translationPath, 'utf-8'),
      ) as Record<string, string>
      if (typeof translation.LANG === 'string') {
        translations.set(translation.LANG, translation)
      }
    } catch (err) {
      log.error(`Failed to load translation ${translationPath}:`, err)
    }
  }
}

const interpolate = (text: string, context: Record<string, string>): string => {
  let interpolatedText = text
  for (const [, match, name] of text.matchAll(/(\$\{([a-z0-9_]+)\})/gi)) {
    interpolatedText = interpolatedText.replace(match, context[name] ?? match)
  }
  return interpolatedText
}

function parseAcceptLanguage(acceptLanguage: string | undefined): string[] {
  if (!acceptLanguage) {
    return []
  }

  const entries = acceptLanguage.split(',').map(entry => {
    const [lang, q] = entry.split(';')
    const quality = q ? parseFloat(q.replace('q=', '').trim()) : 1
    return {
      lang: lang.trim().toLowerCase(),
      quality,
    }
  })

  // Sort by quality descending, filter out * and invalid q values
  return entries
    .filter(e => e.lang !== '*' && !isNaN(e.quality))
    .sort((a, b) => b.quality - a.quality)
    .map(e => e.lang)
}

function selectLanguage(acceptLanguage: string | undefined): string {
  const preferredLanguages = parseAcceptLanguage(acceptLanguage)

  // Try exact matches first
  for (const lang of preferredLanguages) {
    if (translations.has(lang)) {
      return lang
    }
  }

  // Try primary subtag (e.g., 'de' from 'de-DE')
  for (const lang of preferredLanguages) {
    const primary = lang.split('-')[0]
    if (translations.has(primary)) {
      return primary
    }
  }

  // Fallback to English
  return 'en'
}

export function getLinkTypeForRequest(
  headers: Record<string, string | string[] | undefined>,
): 'app' | 'http' {
  const ua = headers['user-agent']
  const userAgent =
    typeof ua === 'string' ? ua : typeof ua === 'object' ? ua[0] : ''

  // I tried the deep link on Android but it didn't work...
  if (/(iPhone|iPad)/.test(userAgent) && LINK_TYPE === 'app') {
    return 'app'
  }

  return 'http'
}

export async function translateHTML(
  html: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
): Promise<string> {
  if (translations.size === 0) {
    try {
      await populateTranslations()
    } catch (err) {
      log.error('Encountered an error reading translation files', err)
    }
  }

  const acceptLanguage = headers['accept-language']
  const acceptLanguageStr =
    typeof acceptLanguage === 'string'
      ? acceptLanguage
      : Array.isArray(acceptLanguage)
        ? acceptLanguage[0]
        : undefined

  const language = selectLanguage(acceptLanguageStr)

  const translationContext: Record<string, string> = translations.has(language)
    ? translations.get(language)!
    : translations.get('en')!

  const htmlText = typeof html === 'string' ? html : html.toString('utf-8')

  const version = getVersion()

  const context = {
    ...translationContext,
    ROOT_PATH,
    VERSION: version,
    CONFIG_MATCHES_TARGET_TYPE:
      getLinkTypeForRequest(headers) === 'app' ? '_self' : '_blank',
  }

  return interpolate(htmlText, context)
}
