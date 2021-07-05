// import { ContainerVolumeResult, getContainerVolumes } from '../executer/execute-docker'
//
// describe('4-execute-docker', () => {
//   it('should', () => {
//     const cwd = getContainerVolumes(
//       {
//         src: [{ absolutePath: '/home/user/repo/src', matcher: () => false }],
//         mounts: [
//           {
//             localPath: '/home/user/.config',
//             containerPath: '/root/.config',
//           },
//         ],
//         path: '/home/user/repo',
//         generates: ['/home/dist'],
//       },
//       false
//     )
//     const result: ContainerVolumeResult = {
//       workingDirectory: '/hammerkit/user/repo',
//       volumes: [
//         {
//           localPath: '/home/user/repo/src',
//           containerPath: '/hammerkit/user/repo/src',
//         },
//         {
//           localPath: '/home/dist',
//           containerPath: '/hammerkit/dist',
//         },
//         {
//           localPath: '/home/user/.config',
//           containerPath: '/root/.config',
//         },
//       ],
//     }
//     expect(cwd).toEqual(result)
//   })
// })
