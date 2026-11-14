import { exceedsQuota, getQuotaRefusal } from './quota-wait'

describe('a refusal of the quota', () => {
  it('is what the message says from the quota on', () => {
    expect(getQuotaRefusal('pods "a" is forbidden: exceeded quota: hammerkit, requested: pods=1')).toBe(
      'exceeded quota: hammerkit, requested: pods=1'
    )
    expect(getQuotaRefusal('pods "a" is forbidden: violates PodSecurity')).toBeNull()
    expect(getQuotaRefusal(undefined)).toBeNull()
  })

  it('never fits when a resource asks for more than the quota allows at all', () => {
    expect(
      exceedsQuota(
        'exceeded quota: hammerkit, requested: limits.memory=4Gi,requests.cpu=8, used: limits.memory=24Gi,requests.cpu=1, limited: limits.memory=26Gi,requests.cpu=6'
      )
    ).toBe(true)
    expect(
      exceedsQuota(
        'exceeded quota: hammerkit, requested: limits.memory=4Gi,requests.cpu=500m, used: limits.memory=24Gi,requests.cpu=1, limited: limits.memory=26Gi,requests.cpu=6'
      )
    ).toBe(false)
    expect(exceedsQuota('exceeded quota: hammerkit')).toBe(false)
  })
})
