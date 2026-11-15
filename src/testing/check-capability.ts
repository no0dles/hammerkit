// A shell check that CAP_SYS_ADMIN (bit 21) is in the effective set: it exits non-zero without
export const checkSysAdmin = `[ $(( 0x$(grep CapEff /proc/self/status | cut -f2) >> 21 & 1 )) = 1 ]`
