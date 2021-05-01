import React, {useEffect, useState} from "react";
import {useStoreState, useStoreActions} from "easy-peasy";
import {Alert, Card, CardContent, CardHeader, Typography} from '@material-ui/core'

export default function Therapists({setShowTherapists}) {
  const emit = useStoreActions(a => a.ws.emit)
  const therapists = useStoreState(s => s.ws.data['users/therapists/get'])

  useEffect(() => {
    emit(['users/therapists/get', {}])
  }, [])

  useEffect(() => {
    if (therapists?.length) {
      setShowTherapists(true)
    }
  }, [therapists])

  const renderTherapist = (t) => {
    let name = '';
    if (t.first_name) {name += t.first_name + ' '}
    if (t.last_name) {name += t.last_name + ' '}
    name += t.email
    return <Card>
      <CardHeader title={name} />
      <CardContent>
        <Typography>{t.bio}</Typography>
      </CardContent>
    </Card>
  }

  return <div className='mt-3'>
    <Alert severity='info'>
      <div>AI-recommended therapists based on your entries.</div>
      <small className='text-muted'>
        <div>AI matches your entries to therapists from their bio & specialties. It's automatic & private, they won't see your data (unless you explicitly share with them under Account > Sharing).</div>
        <div>If you're a therapist wanting listed, check "therapist" under Account > Profile.</div>
      </small>
    </Alert>
    {therapists?.length ? therapists.map(renderTherapist) : (
      <Alert severity='warning'>No therapist matches yet.</Alert>
    )}
  </div>
}
