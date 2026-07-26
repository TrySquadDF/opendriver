import type { ShallowRef } from 'vue'
import type { ConfigurableNavigator } from './_configurable'
import type { Supportable } from './types'
import { tryOnScopeDispose } from '@vueuse/core'
import { shallowReadonly, shallowRef, watch } from 'vue'
import { defaultNavigator } from './_configurable'
import { useEventListener } from '@vueuse/core'
import { useSupported } from '@vueuse/core'

export interface UseHidOptions extends HIDDeviceRequestOptions, ConfigurableNavigator { }

export interface UseHidReturn extends Supportable {
  isConnected: Readonly<ShallowRef<boolean>>

  devices: Readonly<ShallowRef<HIDDevice[] | undefined>>

  requestDevice(): Promise<void>
  getDevices(): Promise<void>

  error: ShallowRef<unknown | undefined>
}

export function useHid(options?: UseHidOptions): UseHidReturn {
  const { filters = [], navigator = defaultNavigator } = options || {}

  const isSupported = useSupported(() => navigator && 'hid' in navigator)
  const isConnected = shallowRef(false)

  const devices = shallowRef<HIDDevice[] | undefined>()
  const error = shallowRef<unknown | undefined>()

  async function requestDevice(): Promise<void> {
    if (!isSupported.value)
      return

    error.value = null

    try {
      // [
      //   ...(devices.value || []).filter(d => !granted.includes(d)),
      //   ...granted,
      // ]
      devices.value = await navigator?.hid.requestDevice({ filters })
    }
    catch (err) {
      error.value = err
    }
  }

  async function getDevices(): Promise<void> {
    if (!isSupported.value)
      return

    // get all devices where permission is received
    devices.value = await navigator!.hid.getDevices()
  }

  function onConnect(event: HIDConnectionEvent) {
    // if we have already received permission to access the device and it is available again in the operating system,
    // the browser will notify us so we can return it to the pool of available devices
    if (!devices.value?.includes(event.device))
      devices.value = [...(devices.value || []), event.device]
  }


  function onDisconnect(event: HIDConnectionEvent) {
    //if, after receiving the permission, the device is no longer available to the browser, we are notified about this
    devices.value = devices.value?.filter(d => d !== event.device)
  }
  if (isSupported.value && navigator) {
    useEventListener(navigator.hid, 'connect', onConnect, { passive: true })
    useEventListener(navigator.hid, 'disconnect', onDisconnect, { passive: true })
  }

  tryOnScopeDispose(() => {
    devices.value?.forEach((device) => {
      if (device.opened)
        device.close()
    })
  })

  return {
    isSupported,
    isConnected: shallowReadonly(isConnected),
    devices: shallowReadonly(devices),
    requestDevice,
    getDevices,
    error,
  }
}
