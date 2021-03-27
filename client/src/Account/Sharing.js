import {Card, Button, Form, Row, Col} from "react-bootstrap"
import React, {useEffect, useState} from "react"
import _ from 'lodash'
import Tags from '../Tags'

import {useStoreState, useStoreActions} from 'easy-peasy'

const feature_map = {
  fields: {
    label: "Fields & Charts",
    help: "User can view your fields & field-entries, history, and charts."
  },
  profile: {
    label: 'Profile & People',
    help: "User can view your profile data and any people you've listed."
  },
  books: {
    label:'Books',
    help: "User can view your AI-recommended books, your bookshelves (liked, disliked, etc), and can recommend books to you (goes to 'Recommended' shelf)."
  },
}

function ShareForm({share=null}) {
  const emit = useStoreActions(a => a.ws.emit)

  const [form, setForm] = useState(share ? _.pick(share, ['email', ..._.keys(feature_map)]) : {})
  const [tags, setTags] = useState(share ? share.tags : {})
  const [saved, setSaved] = useState(false)

  const submit = async e => {
    e.preventDefault()
    const body = {
      ...form,
      tags: tags,
    }
    if (share) {
      setSaved(true)
      emit(['shares/put', {...body, id: share.id}])
      setTimeout(() => {setSaved(false)}, 2000)
    } else {
      emit(['shares/post', body])
      setForm({})
      setTags({})
    }
  }

  const changeEmail = e => {
    setForm({...form, email: e.target.value})
  }

  const chooseFeature = k => e => {
    const v = e.target.checked
    setForm({...form, [k]: v})
  }

  const unshare = async () => {
    emit(['shares/delete', {id: share.id}])
  }

  const ctrlId = 'form' + (share ? share.id : 'new')

  return <div>
    <Form onSubmit={submit}>
      {!share && (
        <Form.Group controlId={`${ctrlId}-email`}>
          <Form.Label>Email address</Form.Label>
          <Form.Control
            type="email"
            required
            placeholder="Enter email"
            value={form.email}
            onChange={changeEmail}
          />
          <Form.Text className="text-muted">
            Email of person you'll share data with
          </Form.Text>
        </Form.Group>
      )}

      {_.map(feature_map, (v, k) => (
        <Form.Group>
          <Form.Check
            id={`${ctrlId}-${k}`}
            type="checkbox"
            label={v.label}
            checked={form[k]}
            onChange={chooseFeature(k)}
          />
          <Form.Text className="text-muted">{v.help}</Form.Text>
        </Form.Group>
      ))}

      <h5>Entries</h5>
      <p className='text-muted small'>
        User can view entries with these tags, and can use features involving these entries:
        <ul>
          <li>Summaries</li>
          <li>Question-answering</li>
          <li>Themes</li>
        </ul>
        Example use: sharing darker entries with a therapist, and lighter entries (eg travel, dreams) with friends.
      </p>
      <Tags
        selected={tags}
        setSelected={setTags}
      />

      <br />
      <br />

      <Button
        variant="primary"
        type="submit"
        disabled={saved}
      >
        {saved ? 'Saved' : share ? 'Save' : 'Submit'}
      </Button>&nbsp;
      {share && <Button variant="danger" size="sm" onClick={unshare}>Unshare</Button>}
    </Form>
  </div>
}

export default function Sharing() {
  const as = useStoreState(state => state.ws.as)
  const emit = useStoreActions(a => a.ws.emit)
  const sharesRes = useStoreState(s => s.ws.res['shares/get'])
  const shares = useStoreState(s => s.ws.data['shares/get'])

  useEffect(() => {
    emit(['shares/get', {}])
  }, [as])

  if (sharesRes?.code === 403) {
    return <h5>{sharesRes.detail}</h5>
  }

  const newForm = <ShareForm />
  if (!shares.length) {return newForm}

  return  <>
    {newForm}
    <hr/>
    <p>Sharing with</p>
    <Row lg={3} sm={2} xs={1}>
      {_.sortBy(shares.slice(), 'id').map(s => (
        <Col key={s.id}>
          <Card>
            <Card.Body>
              <Card.Title>{s.email}</Card.Title>
              <Card.Text>
                <ShareForm share={s} />
              </Card.Text>
            </Card.Body>
          </Card>
        </Col>
      ))}
    </Row>
  </>
}
