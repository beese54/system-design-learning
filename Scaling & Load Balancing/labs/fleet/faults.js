// The fault catalogue.
//
// In its own module for a reason that cost an afternoon: the Health tab needs
// this list, and importing it from instance.js meant importing instance.js -
// which is a script with side effects, so the lab host quietly started an app
// instance inside itself and then reported it as an orphan on port 4311.
//
// Data that several modules need does not belong in a module that also does
// something when you load it.
//
// Each state exists to make one specific health-check idea concrete. The two
// most valuable are `deep-fail` and `zombie`, and almost no course shows either:
// one turns a dependency blip into a total outage, and the other is the case
// where the smartest balancing policy does the worst thing.
export const STATES = {
  healthy: {
    label: 'healthy',
    teaches: 'the control'
  },
  dead: {
    label: 'dead',
    teaches: 'the process is gone. ECONNREFUSED is a GOOD failure - instant and unambiguous. This is the floor for how fast detection can possibly be.'
  },
  hung: {
    label: 'hung',
    teaches: 'the socket accepts and nothing ever answers. The port is open and the service is gone, which is why a TCP health check is worthless.'
  },
  slow: {
    label: 'slow',
    teaches: 'health is not binary. /healthz stays fast while real work crawls, so a pass/fail check sees nothing. This is what least-connections is for.'
  },
  error: {
    label: 'erroring',
    teaches: 'liveness lies. /healthz returns 200 while every real request 500s - the check must exercise the real path.'
  },
  unready: {
    label: 'not ready',
    teaches: 'readiness fails, liveness passes. Stop sending traffic; do NOT restart. The most confused distinction in the field.'
  },
  'deep-fail': {
    label: 'deep check failing',
    teaches: 'readiness depends on the shared database. One blip and the balancer ejects the ENTIRE fleet, turning a degraded dependency into a total outage.'
  },
  zombie: {
    label: 'zombie (fast failure)',
    teaches: 'fails instantly, so it has the lowest latency and fewest in-flight requests - and least-connections funnels MORE traffic into it. The black hole.'
  },
  flapping: {
    label: 'flapping',
    teaches: 'health alternates. Without hysteresis and consecutive-N thresholds the balancer oscillates and half your traffic rides the ejection.'
  }
};

