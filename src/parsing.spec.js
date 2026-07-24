import {
  parseDocuments,
  buildFiles,
  summarizeJson,
  parseFrDate,
  shortHash,
  DOC_DOWNLOAD_BASE
} from './parsing'

describe('parseFrDate', () => {
  it('parses ISO datetime without shifting the calendar day', () => {
    expect(parseFrDate('2026-07-16T00:00:00').toISOString().slice(0, 10)).toBe(
      '2026-07-16'
    )
  })
  it('parses FR DD/MM/YYYY in UTC', () => {
    expect(parseFrDate('23/07/2026').toISOString().slice(0, 10)).toBe(
      '2026-07-23'
    )
  })
  it('returns null on empty/garbage', () => {
    expect(parseFrDate('')).toBeNull()
    expect(parseFrDate('nope')).toBeNull()
  })
})

describe('parseDocuments (espace-documentaire)', () => {
  const payload = {
    hubs: [
      {
        code: 'H_SANTE',
        contrats: [
          {
            identifiant: '00000000000',
            documents: [
              {
                identifiant: 'JWT_AAA',
                libelle: 'Releve de prestations assures',
                codeType: 'RELEVE_DE_PRESTATIONS_SANTE',
                datePublication: '2026-07-16T00:00:00'
              }
            ]
          }
        ]
      }
    ],
    attestationsTiersPayant: {
      contrats: [
        {
          documents: [
            {
              identifiant: 'JWT_ATPG',
              naturePiece: 'ATPG',
              codeType: 'ATTESTATIONS_TIERS_PAYANT',
              datePublication: '2025-12-07T00:00:00'
            }
          ]
        }
      ]
    }
  }

  it('lists health documents with a real edd download url', () => {
    const docs = parseDocuments(payload, { attestations: false })
    expect(docs).toHaveLength(1)
    expect(docs[0].date.toISOString().slice(0, 10)).toBe('2026-07-16')
    expect(docs[0].codeType).toBe('RELEVE_DE_PRESTATIONS_SANTE')
    expect(docs[0].fileurl).toBe(DOC_DOWNLOAD_BASE + 'JWT_AAA/pdf?print=false')
  })
  it('optionally includes tiers-payant attestations', () => {
    expect(parseDocuments(payload, { attestations: true })).toHaveLength(2)
  })
  it('returns [] for null / empty', () => {
    expect(parseDocuments(null)).toEqual([])
    expect(parseDocuments({})).toEqual([])
  })
})

describe('buildFiles (real PDFs)', () => {
  const docs = parseDocuments(
    {
      hubs: [
        {
          contrats: [
            {
              documents: [
                {
                  identifiant: 'JWT_AAA',
                  libelle: 'Releve de prestations assures',
                  codeType: 'RELEVE_DE_PRESTATIONS_SANTE',
                  datePublication: '2026-07-16T00:00:00'
                }
              ]
            }
          ]
        }
      ]
    },
    { attestations: false }
  )
  it('builds a file entry downloading the PDF', () => {
    const [file] = buildFiles(docs)
    expect(file.filename).toMatch(/^2026-07-16_gan_releve_prestations.*\.pdf$/)
    expect(file.fileurl).toBe(DOC_DOWNLOAD_BASE + 'JWT_AAA/pdf?print=false')
    expect(file.vendorRef).toMatch(/^2026-07-16-/)
    expect(file.fileAttributes.metadata.carbonCopy).toBe(true)
  })
})

describe('shortHash', () => {
  it('is stable and distinguishes inputs', () => {
    expect(shortHash('JWT_AAA')).toBe(shortHash('JWT_AAA'))
    expect(shortHash('JWT_AAA')).not.toBe(shortHash('JWT_BBB'))
  })
})

describe('summarizeJson', () => {
  it('summarizes without leaking values', () => {
    expect(summarizeJson({ hubs: [], x: 1 })).toContain('hubs')
  })
})
