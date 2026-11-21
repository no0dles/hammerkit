import { WorkHttpHealthcheck } from '../planner/work-healthcheck'

// how long the request or connection of one check may take
export const HEALTHCHECK_REQUEST_SECONDS = 2

/**
 * An `http` or `tcp` healthcheck, run by a static busybox in the network namespace of the
 * service: no tool of the image does it. It connects to the address the service's hostname
 * names, the one its dependents reach (as the kubelet connects to the pod's), else to
 * 127.0.0.1. Of a request, the status of the first response counts: a redirect is not
 * followed, and a certificate is not checked. Without status codes, any 2xx or 3xx is
 * healthy. Exits 0 when the service is healthy.
 */
const SCRIPT = `b=$1; kind=$2; port=$3; shift 3
addr=127.0.0.1
for a in $($b hostname -i 2>/dev/null); do case $a in *:*) ;; *) addr=$a; break ;; esac; done
if [ "$kind" = tcp ]; then exec $b nc -z -w ${HEALTHCHECK_REQUEST_SECONDS} "$addr" "$port"; fi
scheme=$1; path=$2; shift 2
code=$($b timeout ${HEALTHCHECK_REQUEST_SECONDS} $b wget -S -O /dev/null -Y off --no-check-certificate "$scheme://$addr:$port$path" 2>&1 | $b awk '/^  HTTP\\//{print $2; exit}') 2>/dev/null
[ -n "$code" ] || exit 1
if [ $# -eq 0 ]; then case $code in 2??|3??) exit 0 ;; esac; exit 1; fi
for s in "$@"; do [ "$code" = "$s" ] && exit 0; done
exit 1`

// The check as a command of the busybox at `busybox`.
export function getHealthcheckRequestCommand(
  busybox: string,
  healthcheck: { http: WorkHttpHealthcheck } | { tcp: { port: number } }
): string[] {
  const args =
    'http' in healthcheck
      ? [
          'http',
          `${healthcheck.http.port}`,
          healthcheck.http.scheme,
          healthcheck.http.path,
          ...(healthcheck.http.status ?? []).map((status) => `${status}`),
        ]
      : ['tcp', `${healthcheck.tcp.port}`]
  return [busybox, 'sh', '-c', SCRIPT, 'hammerkit-healthcheck', busybox, ...args]
}
