import {
  parseReimbursements,
  buildBills,
  buildIdentity,
  summarizeJson,
  parseAmount,
  parseFrDate
} from './parsing'

describe('parseAmount', () => {
  it('passes through numbers', () => {
    expect(parseAmount(5.4)).toBe(5.4)
  })
  it('parses French "5,40 €"', () => {
    expect(parseAmount('5,40 €')).toBe(5.4)
  })
  it('handles thousands separator "1.234,56"', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56)
  })
  it('returns NaN on garbage', () => {
    expect(Number.isNaN(parseAmount('abc'))).toBe(true)
  })
})

describe('parseFrDate', () => {
  it('parses ISO dates preserving the calendar day', () => {
    expect(parseFrDate('2026-06-23').toISOString().slice(0, 10)).toBe(
      '2026-06-23'
    )
  })
  it('parses FR DD/MM/YYYY in UTC', () => {
    expect(parseFrDate('23/06/2026').toISOString().slice(0, 10)).toBe(
      '2026-06-23'
    )
  })
  it('returns null on empty/garbage', () => {
    expect(parseFrDate('')).toBeNull()
    expect(parseFrDate('nope')).toBeNull()
  })
})

describe('parseReimbursements (Gan page-remboursements shape)', () => {
  const payload = {
    blocRemboursements: {
      remboursementsParMois: [
        {
          mois: 'Juin',
          annee: 2026,
          remboursements: [
            {
              dateVersement: '2026-06-23',
              montant: '5,40 €',
              partieAyantRecu: 'Laboratoire Exemple',
              action: {
                url: '/remboursements/00000000000/remboursement/10000001'
              }
            }
          ]
        },
        {
          mois: 'Mars',
          annee: 2026,
          remboursements: [
            {
              dateVersement: '2026-03-10',
              montant: '42,30 €',
              partieAyantRecu: 'Pharmacie du Centre',
              action: {
                url: '/remboursements/00000000000/remboursement/10000002'
              }
            }
          ]
        }
      ]
    }
  }
  it('flattens month groups and maps fields', () => {
    const r = parseReimbursements(payload)
    expect(r).toHaveLength(2)
    expect(r[0].amount).toBe(5.4)
    expect(r[0].id).toBe('10000001')
    expect(r[0].label).toBe('Remboursement santé — Laboratoire Exemple')
    expect(r[0].date.toISOString().slice(0, 10)).toBe('2026-06-23')
  })
})

describe('parseReimbursements (recent list shape)', () => {
  it('reads remboursementsRecents with numeric amounts', () => {
    const r = parseReimbursements({
      remboursementsRecents: [
        {
          montantDuVersement: 12.5,
          dateDuVersement: '2026-07-01',
          destinataireDuPaiement: 'Dr Martin',
          action: { url: '/remboursements/00000000000/remboursement/10000003' }
        }
      ]
    })
    expect(r).toHaveLength(1)
    expect(r[0].amount).toBe(12.5)
    expect(r[0].id).toBe('10000003')
  })
})

describe('parseReimbursements edge cases', () => {
  it('returns [] for null / empty / invalid', () => {
    expect(parseReimbursements(null)).toEqual([])
    expect(parseReimbursements({})).toEqual([])
    expect(
      parseReimbursements({
        blocRemboursements: {
          remboursementsParMois: [{ remboursements: [{ foo: 'bar' }] }]
        }
      })
    ).toEqual([])
  })
})

describe('buildBills', () => {
  const reimbursements = parseReimbursements({
    blocRemboursements: {
      remboursementsParMois: [
        {
          mois: 'Juin',
          annee: 2026,
          remboursements: [
            {
              dateVersement: '2026-06-23',
              montant: '5,40 €',
              partieAyantRecu: 'Laboratoire Exemple',
              action: {
                url: '/remboursements/00000000000/remboursement/10000001'
              }
            }
          ]
        }
      ]
    }
  })
  it('marks bills as refunds with a text receipt', () => {
    const [bill] = buildBills(reimbursements)
    expect(bill.isRefund).toBe(true)
    expect(bill.amount).toBe(5.4)
    expect(bill.vendor).toBe('Gan Assurances')
    expect(bill.vendorRef).toBe('10000001')
    expect(bill.filename).toBe('2026-06-23_gan_remboursement_5,40EUR.txt')
    expect(bill.fileAttributes.metadata.carbonCopy).toBe(true)
    expect(bill.dataUri).toMatch(/^data:text\/plain;base64,/)
    expect(bill.fileurl).toBeUndefined()
    const decoded = Buffer.from(bill.dataUri.split(',')[1], 'base64').toString(
      'utf8'
    )
    expect(decoded).toContain('5,40 €')
    expect(decoded).toContain('Laboratoire Exemple')
  })
})

describe('buildIdentity', () => {
  it('keeps only name and email (no address / civil data)', () => {
    const id = buildIdentity({
      userinfo: {
        response: {
          given_name: 'Jean',
          family_name: 'Dupont',
          email: 'j@d.fr',
          address: 'should be ignored'
        }
      }
    })
    expect(id.contact.name).toEqual({ givenName: 'Jean', familyName: 'Dupont' })
    expect(id.contact.email).toEqual([{ address: 'j@d.fr' }])
    expect(id.contact.address).toBeUndefined()
  })
  it('returns null when nothing usable', () => {
    expect(buildIdentity({})).toBeNull()
    expect(buildIdentity(undefined)).toBeNull()
  })
})

describe('summarizeJson', () => {
  it('summarizes without leaking values', () => {
    expect(summarizeJson([{ a: 1, b: 2 }])).toContain('Array(1)')
    expect(summarizeJson({ blocRemboursements: [], x: 1 })).toContain(
      'blocRemboursements'
    )
  })
})
