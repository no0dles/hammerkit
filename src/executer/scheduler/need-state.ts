import { ServiceDns } from '../service-dns'

export interface NeedState {
  ready: boolean
  dns: { [key: string]: ServiceDns }
  services: {
    [key: string]: ServiceReadyState
  }
}

export type ServiceReadyState =
  | { name: string; ready: true; stateKey: string }
  | { name: string; ready: false; stateKey: string | null }

// export function createNeedState(item: WorkItem<WorkNode | WorkService>): WorkState<NeedState> {
//   return combineLatest(
//     item.needs.map((n) => n.service.state),
//     (states) => {
//       const services = states.reduce<{ [key: string]: ServiceReadyState }>((services, state) => {
//         if (state.type === 'running') {
//           services[state.itemId] = {
//             name: state.service.name,
//             stateKey: state.stateKey,
//             ready: true,
//           }
//         } else {
//           services[state.itemId] = {
//             name: state.service.name,
//             stateKey: state.stateKey ?? null,
//             ready: false,
//           }
//         }
//         return services
//       }, {})
//       const dns = states.reduce<{ [key: string]: ServiceDns }>((services, state) => {
//         if (state.type === 'running') {
//           services[state.service.name] = state.dns
//         }
//         return services
//       }, {})
//
//       return {
//         ready: states.every((s) => s.type === 'running'),
//         services,
//         dns,
//       }
//     }
//   )
// }
