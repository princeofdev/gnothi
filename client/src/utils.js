const fetch_ = async (route, method='GET', body=null, jwt=null) => {
  const obj = {
    method,
    headers: {'Content-Type': 'application/json'},
  };
  if (body) obj['body'] = JSON.stringify(body)
  if (jwt) obj['headers']['Authorization'] = `JWT ${jwt}`
  const response = await fetch(`http://127.0.0.1:5001/${route}`, obj)
  return await response.json()
}

export {fetch_}