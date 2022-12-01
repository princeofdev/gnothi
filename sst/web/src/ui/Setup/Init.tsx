import React, {useEffect, useCallback} from "react";
import {useLocation} from "react-router-dom";
import {useStore} from "../../data/store";
import shallow from "zustand/shallow";

export default function Init() {
  const setUser = useStore(useCallback(state => state.setUser, []))
  const location = useLocation()

  // listen to changes across, me, as, and users-list. Only set the viewer
  // when things needed are present.
  useEffect(() => {
    return useStore.subscribe(
      (state) => [
        state.user,
        state.res.users_list_response,
      ],
      ((state, prevState) => {
        // Note: editor having trouble with subscribeWithSelector typing, ignore errors
        const [user, users] = state
        // users list not available to set the viewer. Loading indicator elsewhere
        if (!users?.ids?.length) {return}
        if (!user.me) {
          const me = users.hash[users.ids[0]]
          setUser({me, viewer: me, as: null})
          return
        }
        // TODO handle as switch
        // if (viewer.asId && hash[viewer.asId]) {
        //   get().send('users_everything_request', {})
        // }
      }),
      // {equalityFn: shallow, fireImmediately: false}
    )
  }, [])

  useEffect(() => {
    const search = new URLSearchParams(location.search)
    const code = search.get("code")
    if (code) {
      window.localStorage.setItem("affiliate", code)
    }
  }, [])

  return null
}